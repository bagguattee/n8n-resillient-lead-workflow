import { checkIfTrash, checkDncCompliance } from './core/gates.ts';
import { deduplicateLeads } from './core/dedup.ts';
import type { DedupResult } from './core/dedup.ts';
import {
  normalizeEmail,
  normalizeEstimatedValue,
  normalizeJobType,
  normalizeLeadStatus,
  normalizePhone,
  parseContactDate,
  sanitizeText,
  toTitleCase,
} from './core/normalizer.ts';
import { WaterfallEnrichmentEngine } from './enrichment/waterfall.ts';
import { evaluateLeadHeuristics } from './triage/aiTriage.ts';
import { InvariantLedger } from './ledger/invariantLedger.ts';
import { GoHighLevelClient } from './ghl/ghlClient.ts';
import { IdempotencyGuard } from './security/idempotency.ts';
import type {
  MasterLeadRecord,
  NormalizedLead,
  RawLeadPayload,
} from './types/index.ts';

export interface PipelineExecutionOptions {
  enableEnrichment?: boolean;
  enableAiTriage?: boolean;
  enableGhlDispatch?: boolean;
  country?: string;
}

export interface PipelineBatchResult {
  ledgerVerification: ReturnType<InvariantLedger['verify']>;
  cleanMasters: MasterLeadRecord[];
  quarantinedMasters: MasterLeadRecord[];
  auditLogs: DedupResult['auditLogs'];
  enrichmentCostsCents: number;
}

export class ResilientLeadPipelineEngine {
  public idempotency: IdempotencyGuard;
  public enricher: WaterfallEnrichmentEngine;
  public ghlClient: GoHighLevelClient;
  public ledger: InvariantLedger;

  constructor() {
    this.idempotency = new IdempotencyGuard();
    this.enricher = new WaterfallEnrichmentEngine();
    this.ghlClient = new GoHighLevelClient();
    this.ledger = new InvariantLedger();
  }

  /**
   * Normalizes a single raw payload into strict NormalizedLead contract.
   */
  public normalizeLead(raw: RawLeadPayload, country = 'US'): NormalizedLead {
    const rawId = raw.lead_id || `lead_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const payloadHash = this.idempotency.computePayloadHash(raw);

    const phone_e164 = normalizePhone(raw.phone, country);
    const emailResult = normalizeEmail(raw.email);

    let firstName = toTitleCase(raw.first_name);
    let lastName = toTitleCase(raw.last_name);

    if ((!firstName || !lastName) && raw.full_name) {
      const parts = toTitleCase(raw.full_name).split(' ');
      if (!firstName) firstName = parts[0] || '';
      if (!lastName) lastName = parts.slice(1).join(' ') || '';
    }

    const fullName = [firstName, lastName].filter(Boolean).join(' ');

    const street_address = sanitizeText(raw.street_address);
    const city = toTitleCase(raw.city) || null;
    const state = sanitizeText(raw.state)?.toUpperCase() || null;
    const postal_code = sanitizeText(raw.postal_code);

    const job_type = normalizeJobType(raw.job_type);
    const estimated_value = normalizeEstimatedValue(raw.estimated_value);
    const lead_status = normalizeLeadStatus(raw.lead_status);

    const dncCheck = checkDncCompliance(raw);
    const is_dnc = dncCheck.isDnc;

    const trashCheck = checkIfTrash(raw, phone_e164, emailResult.primary);
    const is_trash = trashCheck.isTrash;

    let is_quarantined = is_trash || is_dnc || emailResult.isDisposable;
    let quarantine_reason: string | undefined = undefined;

    if (is_trash) {
      quarantine_reason = `[TRASH] ${trashCheck.reason}`;
    } else if (is_dnc) {
      quarantine_reason = `[DNC] ${dncCheck.reason || 'Opted-out contact'}`;
    } else if (emailResult.isDisposable) {
      quarantine_reason = '[DISPOSABLE] Disposable email domain flagged';
    }

    return {
      raw_id: rawId,
      payload_hash: payloadHash,
      first_name: firstName,
      last_name: lastName,
      full_name: fullName,
      phone_e164,
      secondary_phone_e164: normalizePhone(raw.mobile_phone, country),
      email: emailResult.primary,
      secondary_email: emailResult.secondary,
      street_address,
      city,
      state,
      postal_code,
      job_type,
      estimated_value,
      lead_status,
      is_dnc,
      is_trash,
      contact_date: parseContactDate(raw.contact_date || raw.submitted_at),
      submitted_at: parseContactDate(raw.submitted_at),
      is_quarantined,
      quarantine_reason,
    };
  }

  /**
   * Executes full batch ingestion, deduplication, enrichment, triage, and reconciliation ledger.
   */
  public async processBatch(
    rawPayloads: RawLeadPayload[],
    options: PipelineExecutionOptions = {}
  ): Promise<PipelineBatchResult> {
    const {
      enableEnrichment = true,
      enableAiTriage = true,
      enableGhlDispatch = true,
      country = 'US',
    } = options;

    this.ledger.reset();

    const normalizedList: NormalizedLead[] = [];

    // 1. Ingest & Normalize
    for (const raw of rawPayloads) {
      const rawId = raw.lead_id || `raw_${Math.random().toString(36).substring(2, 8)}`;
      this.ledger.recordIngest(rawId);

      const lead = this.normalizeLead({ ...raw, lead_id: rawId }, country);
      normalizedList.push(lead);
    }

    // 2. Separate trash from identifiable entities
    // Identifiable leads (even if DNC) enter deduplication so compliance broadcasts across the identity cluster
    const viableForDedup: NormalizedLead[] = [];
    const directQuarantine: NormalizedLead[] = [];

    for (const lead of normalizedList) {
      if (lead.is_trash) {
        directQuarantine.push(lead);
      } else {
        viableForDedup.push(lead);
      }
    }

    // 3. Deduplicate & Entity Resolution on viable leads
    const dedupResult = deduplicateLeads(viableForDedup);

    // Record duplicates in ledger
    for (const log of dedupResult.auditLogs) {
      this.ledger.recordDuplicate(log.merged_id, log.cluster_id, log.reason);
    }

    // Combine direct quarantine with cluster-level quarantined leads (e.g. DNC overrides)
    const allQuarantined: MasterLeadRecord[] = [
      ...dedupResult.quarantined,
      ...directQuarantine.map(lead => ({
        ...lead,
        master_id: `mst_${lead.raw_id}`,
        merged_lead_ids: [lead.raw_id],
        additional_phones: [],
        additional_emails: [],
        additional_addresses: [],
        is_hub_identifier: false,
        created_at: lead.submitted_at,
        updated_at: new Date(),
      })),
    ];

    for (const q of allQuarantined) {
      this.ledger.recordQuarantined(q.raw_id, q.quarantine_reason || 'Quarantined');
    }

    // 4. Process Clean Masters (Enrichment, AI Triage, GHL Dispatch)
    const cleanMasters: MasterLeadRecord[] = [];

    for (const master of dedupResult.masters) {
      let enrichedMaster = { ...master };

      // Optional Waterfall Enrichment
      if (enableEnrichment && (enrichedMaster.street_address || enrichedMaster.phone_e164)) {
        const lookupKey = enrichedMaster.street_address || enrichedMaster.phone_e164!;
        enrichedMaster.enrichment = await this.enricher.enrich(lookupKey);
      }

      // Optional AI Lead Triage
      if (enableAiTriage) {
        enrichedMaster.ai_triage = evaluateLeadHeuristics(enrichedMaster);
      }

      // Optional GHL Dispatch
      if (enableGhlDispatch) {
        await this.ghlClient.dispatchLead(enrichedMaster);
      }

      this.ledger.recordProcessed(enrichedMaster.raw_id);
      cleanMasters.push(enrichedMaster);
    }

    // 5. Verification of the Invariant Ledger Equation
    const ledgerVerification = this.ledger.verify();

    return {
      ledgerVerification,
      cleanMasters,
      quarantinedMasters: allQuarantined,
      auditLogs: dedupResult.auditLogs,
      enrichmentCostsCents: this.enricher.getTotalCostCents(),
    };
  }
}
