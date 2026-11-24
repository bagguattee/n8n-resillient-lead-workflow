import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  normalizePhone,
  normalizeEmail,
  toTitleCase,
  isPlaceholder,
  sanitizeText,
} from '../src/core/normalizer.ts';
import { checkIfTrash, checkDncCompliance, identifyHubs } from '../src/core/gates.ts';
import { deduplicateLeads } from '../src/core/dedup.ts';
import { verifyWebhookSignature } from '../src/security/signature.ts';
import { IdempotencyGuard } from '../src/security/idempotency.ts';
import { WaterfallEnrichmentEngine, LocalCacheEnrichmentProvider, PrimaryMockEnrichmentProvider, FallbackMockEnrichmentProvider } from '../src/enrichment/waterfall.ts';
import { parseAndValidateAiTriage, evaluateLeadHeuristics } from '../src/triage/aiTriage.ts';
import { InvariantLedger } from '../src/ledger/invariantLedger.ts';
import { GoHighLevelClient } from '../src/ghl/ghlClient.ts';
import { ResilientLeadPipelineEngine } from '../src/pipeline.ts';
import type { NormalizedLead, RawLeadPayload } from '../src/types/index.ts';

describe('Resilient Lead Pipeline Test Suite', () => {
  describe('1. Data Hygiene & Normalization', () => {
    it('normalizes 10-digit US phone to E.164 (+1XXXXXXXXXX)', () => {
      const phone = normalizePhone('(303) 555-0192');
      assert.equal(phone, '+13035550192');
    });

    it('cleans excel float trailing .0 from phone numbers', () => {
      const phone = normalizePhone('3035550192.0');
      assert.equal(phone, '+13035550192');
    });

    it('rejects corrupt/short phone numbers', () => {
      assert.equal(normalizePhone('12345'), null);
      assert.equal(normalizePhone('0000000000'), null);
    });

    it('auto-corrects common email domain typos', () => {
      const result = normalizeEmail('john.doe@gamil.com');
      assert.equal(result.primary, 'john.doe@gmail.com');
      assert.equal(result.isDisposable, false);
    });

    it('detects and flags disposable email domains', () => {
      const result = normalizeEmail('testuser@mailinator.com');
      assert.equal(result.isDisposable, true);
    });

    it('scrubs bad placeholders into null values instead of shipping them to CRM', () => {
      assert.equal(isPlaceholder('idk'), true);
      assert.equal(isPlaceholder('n/a'), true);
      assert.equal(isPlaceholder('none'), true);
      assert.equal(sanitizeText('idk'), null);
      assert.equal(normalizePhone('none'), null);
      assert.equal(normalizeEmail('n/a').primary, null);
    });

    it('properly formats names with title case and handles hyphens/apostrophes', () => {
      assert.equal(toTitleCase("o'connor"), "O'Connor");
      assert.equal(toTitleCase('smith-jones'), 'Smith-Jones');
      assert.equal(toTitleCase('  john   doe  '), 'John Doe');
    });
  });

  describe('2. Security: Signatures & Idempotency', () => {
    const secret = 'super-secret-webhook-key-2026';

    it('validates authentic HMAC-SHA256 signatures', () => {
      const payload = JSON.stringify({ lead_id: 'lead_123', email: 'test@example.com' });
      const signature = createHmac('sha256', secret).update(payload).digest('hex');

      const isValid = verifyWebhookSignature(payload, signature, secret);
      assert.equal(isValid, true);
    });

    it('rejects tampered payloads or invalid signatures', () => {
      const payload = JSON.stringify({ lead_id: 'lead_123', email: 'test@example.com' });
      const tamperedPayload = JSON.stringify({ lead_id: 'lead_123', email: 'hacker@example.com' });
      const signature = createHmac('sha256', secret).update(payload).digest('hex');

      const isValid = verifyWebhookSignature(tamperedPayload, signature, secret);
      assert.equal(isValid, false);
    });

    it('idempotency guard detects and blocks duplicate payload submissions', () => {
      const guard = new IdempotencyGuard(60000); // 1 minute window
      const payload = { email: 'repeat@example.com', phone: '3035551212' };

      const check1 = guard.checkIdempotency(payload);
      assert.equal(check1.isDuplicate, false);

      guard.register('key_1', guard.computePayloadHash(payload));

      const check2 = guard.checkIdempotency('key_1');
      assert.equal(check2.isDuplicate, true);
    });
  });

  describe('3. Gates & Hub Detection', () => {
    it('flags test leads, gibberish names, or missing contact channels as trash', () => {
      const trash1 = checkIfTrash({ first_name: 'test', last_name: 'dummy' }, '+13035550192', 'valid@gmail.com');
      assert.equal(trash1.isTrash, true);

      const trash2 = checkIfTrash({ first_name: 'John', last_name: 'Doe' }, null, null);
      assert.equal(trash2.isTrash, true);
    });

    it('detects commercial hub phone lines shared across >3 households to prevent false merges', () => {
      const leads: NormalizedLead[] = [
        createMockLead('1', 'Smith', '+13035559999', '123 Pine St'),
        createMockLead('2', 'Johnson', '+13035559999', '456 Oak St'),
        createMockLead('3', 'Williams', '+13035559999', '789 Elm St'),
        createMockLead('4', 'Brown', '+13035559999', '101 Maple St'),
      ];

      const { hubPhones } = identifyHubs(leads, 3);
      assert.equal(hubPhones.has('+13035559999'), true);
    });
  });

  describe('4. Deduplication & Compliance Invariant', () => {
    it('merges records on Tier 1 (Phone + Surname) and preserves secondary data', () => {
      const leadA = createMockLead('10', 'Miller', '+13035551122', '100 Main St', 'miller1@gmail.com', 5000);
      const leadB = createMockLead('11', 'Miller', '+13035551122', '100 Main St', 'miller2@work.com', 7000);

      const result = deduplicateLeads([leadA, leadB]);
      assert.equal(result.masters.length, 1);
      assert.equal(result.totalMergedCount, 1);

      const master = result.masters[0]!;
      assert.equal(master.estimated_value, 12000);
      assert.equal(master.additional_emails.includes('miller2@work.com') || master.additional_emails.includes('miller1@gmail.com'), true);
    });

    it('strict compliance override: DNC flag on ANY record in cluster quarantines entire cluster', () => {
      const cleanLead = createMockLead('20', 'Harrison', '+13035554444', '200 High St', 'harrison@gmail.com', 18000, false);
      const dncLead = createMockLead('21', 'Harrison', '+13035554444', '200 High St', 'harrison.alt@gmail.com', 2000, true);

      const result = deduplicateLeads([cleanLead, dncLead]);
      assert.equal(result.masters.length, 0); // No clean master allowed
      assert.equal(result.quarantined.length, 1);
      assert.equal(result.quarantined[0]!.is_dnc, true);
      assert.equal(result.quarantined[0]!.is_quarantined, true);
    });
  });

  describe('5. Mock Waterfall Enrichment Engine', () => {
    it('executes sequential fallback (Local Cache -> Primary -> Fallback) and records costs', async () => {
      const localCache = new LocalCacheEnrichmentProvider();
      const primaryApi = new PrimaryMockEnrichmentProvider(['unknown-street-fail']);
      const fallbackApi = new FallbackMockEnrichmentProvider();
      const engine = new WaterfallEnrichmentEngine(localCache, primaryApi, fallbackApi);

      // Call 1: Misses local cache, hits Primary Mock API ($0.05)
      const res1 = await engine.enrich('123 Main St');
      assert.equal(res1.provider, 'PRIMARY_API');
      assert.equal(res1.cost_cents, 5);
      assert.equal(res1.cached, false);

      // Call 2: Exact same address hits Local Cache ($0.00)
      const res2 = await engine.enrich('123 Main St');
      assert.equal(res2.provider, 'LOCAL_CACHE');
      assert.equal(res2.cost_cents, 0);
      assert.equal(res2.cached, true);

      // Call 3: Primary fails on this address, falls back to Fallback Mock API ($0.12 + $0.05)
      const res3 = await engine.enrich('unknown-street-fail');
      assert.equal(res3.provider, 'FALLBACK_API');
      assert.equal(res3.cost_cents, 17); // 5 primary + 12 fallback
    });
  });

  describe('6. AI Lead Triage Schema Validation', () => {
    it('validates strict JSON schema and clamps urgency/confidence', () => {
      const validJson = JSON.stringify({
        urgency: 5,
        intent_category: 'IMMEDIATE_STORM_DAMAGE',
        confidence_score: 0.95,
        qualification_status: 'QUALIFIED',
        recommended_action: 'Dispatch urgent repair team',
        summary_for_sales: 'Active ceiling leak after storm',
      });

      const triage = parseAndValidateAiTriage(validJson);
      assert.equal(triage.urgency, 5);
      assert.equal(triage.intent_category, 'IMMEDIATE_STORM_DAMAGE');
      assert.equal(triage.qualification_status, 'QUALIFIED');
    });

    it('demotes to REVIEW_REQUIRED if confidence score is < 0.70', () => {
      const lowConfJson = JSON.stringify({
        urgency: 4,
        intent_category: 'SCHEDULED_REPLACEMENT',
        confidence_score: 0.62,
        qualification_status: 'QUALIFIED',
        recommended_action: 'Review manually',
        summary_for_sales: 'Ambiguous roof size',
      });

      const triage = parseAndValidateAiTriage(lowConfJson);
      assert.equal(triage.qualification_status, 'REVIEW_REQUIRED');
    });
  });

  describe('7. Reconciliation Invariant Ledger & End-to-End Batch', () => {
    it('balances Ingested = Processed + Duplicates + Quarantined + Failed', async () => {
      const pipeline = new ResilientLeadPipelineEngine();

      const batch: RawLeadPayload[] = [
        // 1. Clean valid lead
        { lead_id: 'L1', first_name: 'Alice', last_name: 'Walker', phone: '3035550001', email: 'alice@gmail.com', job_type: 'Replacement', estimated_value: 12000 },
        // 2. Duplicate of Alice (same phone & surname)
        { lead_id: 'L2', first_name: 'Alice', last_name: 'Walker', phone: '3035550001', email: 'alice.work@corp.com', job_type: 'Replacement', estimated_value: 2000 },
        // 3. Absolute trash (missing contact channels)
        { lead_id: 'L3', first_name: 'Test', last_name: 'User', phone: '0000000000', email: 'idk' },
        // 4. Opted-out / DNC lead
        { lead_id: 'L4', first_name: 'Bob', last_name: 'Stone', phone: '3035550004', email: 'bob@stone.com', compliance_opt_out: true },
      ];

      const result = await pipeline.processBatch(batch, { enableGhlDispatch: false });

      // Ingested = 4:
      // Processed (Alice Master) = 1
      // Duplicates (Alice L2) = 1
      // Quarantined (Trash L3 + DNC L4) = 2
      // Failed = 0
      // Total accounted = 1 + 1 + 2 + 0 = 4!
      assert.equal(result.ledgerVerification.isBalanced, true);
      assert.equal(result.ledgerVerification.ledger.ingested, 4);
      assert.equal(result.ledgerVerification.ledger.processed, 1);
      assert.equal(result.ledgerVerification.ledger.duplicates, 1);
      assert.equal(result.ledgerVerification.ledger.quarantined, 2);
      assert.equal(result.ledgerVerification.discrepancy, 0);
    });
  });
});

function createMockLead(
  id: string,
  lastName: string,
  phone: string,
  address: string,
  email = `${lastName.toLowerCase()}@test.com`,
  estimatedValue = 5000,
  isDnc = false
): NormalizedLead {
  return {
    raw_id: id,
    payload_hash: `hash_${id}`,
    first_name: 'Test',
    last_name: lastName,
    full_name: `Test ${lastName}`,
    phone_e164: phone,
    email,
    street_address: address,
    city: 'Denver',
    state: 'CO',
    postal_code: '80202',
    job_type: 'REPLACEMENT',
    estimated_value: estimatedValue,
    lead_status: 'NEW',
    is_dnc: isDnc,
    contact_date: new Date('2026-01-01'),
    submitted_at: new Date('2026-01-01'),
    is_quarantined: isDnc,
    quarantine_reason: isDnc ? 'DNC opt-out' : undefined,
  };
}
