# Resilient Lead Pipeline & GHL Centralization Hub

An event-driven lead ingestion and data integrity engine built with **n8n** and **TypeScript**. 

This system serves as **Phase 3** of the roofing lead pipeline architecture, succeeding the [Phase 1 Batch Python Engine](https://github.com/bagguattee/roofing-lead-pipeline) and the [Phase 2 Make.com/GHL Automations](https://github.com/bagguattee/automation-workflows). It transitions the pipeline from batch CSV processing to a real-time event architecture featuring cryptographic payload validation, deterministic compliance gates, waterfall property cache lookups, cognitive triage via Groq LLM (`openai/gpt-oss-120b`), and a two-sided reconciliation ledger that guarantees zero untracked leads.

---

## The Engineering Problem

High-ticket residential contracting pipelines (roofing, solar, HVAC) deal with three consistent failure modes:

1. **Compliance Liability vs. Revenue Bias:** Lead forms frequently contain opt-out requests or invalid numbers. When pipelines prioritize deal size over compliance, companies face statutory fines under the Telephone Consumer Protection Act (TCPA) of \$500 to \$1,500 per automated text or call.
2. **API Bill Shock & Hallucinated Data:** Calling paid property intelligence APIs (ATTOM, Estated, Google Solar) on every raw webhook costs \$0.05 to \$0.15 per lookup, regardless of whether the lead is viable or duplicate. Conversely, asking an LLM to guess property dimensions produces hallucinations.
3. **Silent Drops & Lack of Auditability:** Most CRM automations follow a naive `Webhook -> CRM Push` pattern. If an integration fails or a lead is dropped due to validation, there is no immutable receipt, making financial attribution and operational auditing impossible.

This pipeline solves all three through explicit architectural separation: **deterministic code for facts, persistent data tables for state and cost tracking, and an LLM strictly for unstructured human language triage.**

---

## Architecture & Workflow Map

The production workflow ([`resilient-lead-pipeline-ghl.json`](n8n/workflows/resilient-lead-pipeline-ghl.json)) runs 19 purpose-built nodes organized into 4 distinct architectural groups:

```
                      [Inbound Lead Webhook] (POST /webhook/lead-ingest)
                                │
                                ▼
       ┌────────────────────────────────────────────────────────┐
       │ 1. Security & In-Process Field Normalization           │
       │  • Compute Payload Hash: SHA-256 digital digest        │
       │  • Normalize and Scrub Lead Fields:                    │
       │    - Phone to strict E.164 (+1XXXXXXXXXX)              │
       │    - Email domain typo correction (gamil -> gmail)     │
       │    - Rejection of junk placeholders ("idk", "none")    │
       │  • Is Signature Valid? -> 401 Unauthorized on tamper   │
       └────────────────────────┬───────────────────────────────┘
                                │
                                ▼
                   [Passes Policy and DNC Gates?]
                                │
          ┌─────────────────────┴─────────────────────┐
          ▼ (Fail: DNC / Burner / Trash)              ▼ (Pass: Viable & Compliant)
┌───────────────────────────────────────────┐  ┌────────────────────────────────────────────┐
│ 2. TCPA Compliance & Quarantine Hold      │  │ 3. Waterfall Enrichment & LLM Triage       │
│  • Record Quarantine in Ledger (Table)    │  │  • Lookup Property Cache (Table: $0.00)     │
│  • Append Quarantine Audit Log (Table)    │  │  • Resolve Waterfall Enrichment            │
│  • Sync GHL Compliance Hold (DND enabled) │  │    (Cache -> Primary API $0.05 -> Fallback) │
│  • Respond 202 Quarantined                │  │  • AI Lead Triage Extractor (Groq LLM)     │
└───────────────────────────────────────────┘  └──────────────────────┬─────────────────────┘
                                                                      │
                                                                      ▼
                                               ┌────────────────────────────────────────────┐
                                               │ 4. CRM Dispatch & Settlement               │
                                               │  • Is High Urgency Lead?                   │
                                               │    (urgency >= 4 AND confidence >= 0.70)   │
                                               │    ├── Hot Priority Route (Instant Alert)  │
                                               │    └── Standard Route (Nurture Sequence)   │
                                               │  • Record Processed Lead in Ledger (Table) │
                                               │  • Respond 200 Lead Processed              │
                                               └────────────────────────────────────────────┘
```

---

## System Design & Trade-Offs

### 1. Synchronous HTTP Status Semantics
Instead of terminating silent drops on invalid branches, the webhook explicitly returns standards-compliant HTTP status codes:
- **`200 OK`**: Lead passed all gates, was enriched, triaged by LLM, and dispatched to the CRM.
- **`202 Accepted`**: Lead received and parsed, but quarantined due to policy/compliance rules. Prevents upstream webhooks (e.g., Zapier, Meta Ads) from retrying endlessly while acknowledging receipt.
- **`401 Unauthorized`**: Payload signature missing or forged. Halts execution immediately without exposing internal failure details.

### 2. Compliance Overrides Revenue
In test case `LEAD_2026_002`, the lead represented an estimated **\$18,000** full roof replacement. However, the contact checked the DNC opt-out box (`compliance_opt_out: true`). 
- **The Decision:** The gate immediately isolates the record to the Quarantine Hold branch.
- **The Settlement:** The contact is written to the legal audit log, and pushed to GoHighLevel with a strict `DND` (Do Not Disturb) flag and `quarantined-tcpa-hold` tag. Marketing automation cannot text them, shielding the business from regulatory action.

### 3. Graceful Waterfall Degradation (Unit Cost Optimization)
- **Layer 1: Local Cache Table ($0.00):** If the property address was previously enriched within the retention window, data is served from the internal n8n table in <5ms.
- **Layer 2: Primary Property API ($0.05):** For new addresses, external county/property APIs (ATTOM, Estated, Google Solar) are called.
- **Layer 3: Resilient Fallback Adapter ($0.12):** If an external vendor API is down, rate-limited, or unconfigured during testing, deterministic structural heuristics infer baseline specs from the parcel address. Downstream LLM triage and CRM routing continue without crashing.

### 4. Deterministic Code vs. LLM Cognition
- **Code Handles Facts:** Phone normalization, address keys, cache indexing, and math are strictly executed in deterministic expressions.
- **LLM Handles Human Ambiguity:** The Groq LLM (`openai/gpt-oss-120b`) is prompted through an `Information Extractor` node with structured attributes (`urgency: 1-5`, `intent_category`, `confidence_score`). It evaluates human nuance (e.g., differentiating *"water pouring through the nursery ceiling"* from *"just shopping for quotes next year"*) without hallucinating square footage.

---

## Live n8n Verification Results

The workflow was verified live against 4 real-world test cases on a dedicated n8n instance:

### Table 1: `Lead Reconciliation Ledger` (Total Master Audit)
Every incoming webhook is logged with its payload SHA-256 digest, enrichment cost, and CRM route:

| Lead ID | Full Name | Contact Cleaned | Status | Urgency | Intent Category | Cost | CRM Disposition |
|---|---|---|---|---|---|---|---|
| `LEAD_2026_001` | Marcus Vance | `+13035550192` / `marcus.vance@gmail.com` | **`PROCESSED`** | 5 / 5 | `IMMEDIATE_STORM_DAMAGE` | \$0.00 (Cache) | Hot Priority Dispatch |
| `LEAD_2026_002` | Mark Smith | `+15559990000` / `mark@smith.com` | **`QUARANTINED`** | — | TCPA DNC Opt-Out | \$0.00 | GHL Compliance DND Hold |
| `LEAD_2026_003` | Sarah Jenkins | `+13035558877` / `sarah.j@yahoo.com` | **`PROCESSED`** | 3 / 5 | `MINOR_REPAIR` | \$0.05 (API) | Standard Nurture Route |
| `LEAD_2026_004` | UNIDENTIFIED | *(empty phone)* / `fakelead@mailinator.com` | **`QUARANTINED`** | — | Burner Email / Dummy Name | \$0.00 | GHL Compliance DND Hold |

**The Reconciliation Invariant:**
$$\text{Total Received (4)} = \text{Processed (2)} + \text{Quarantined (2)} + \text{System Failures (0)}$$
Discrepancy: **0 leads**.

### Table 2: `Quarantine TCPA Audit Log` (Legal Defense Record)

| Lead ID | Full Name | Identifier | Quarantine Trigger Reason | GHL DND Synced |
|---|---|---|---|---|
| `LEAD_2026_002` | Mark Smith | `mark@smith.com` | `[DNC] Explicit TCPA opt-out or DNC compliance keyword detected` | `true` |
| `LEAD_2026_004` | UNIDENTIFIED | `fakelead@mailinator.com` | `[DISPOSABLE] Burner email domain blocked` | `true` |

---

## Test Suite & Local Verification

In addition to live n8n workflow execution, the repository includes a standalone TypeScript verification engine that runs automated tests against historical CRM exports:

```bash
# Run unit & integration tests (Node 24 native TypeScript support)
npm test

# Run 100-record benchmark against historical messy CSV
npm run test:csv
```

**Test Results:**
- 18 unit tests passed (HMAC signatures, E.164 sanitization, hub detection, reconciliation invariants).
- 100 historical records processed: `79 Processed + 13 Quarantined + 8 Duplicates Deduped + 0 System Failures`. Zero data leakage.

---

## Repository Map

```
resilient-lead-pipeline/
├── CONTRACTS.md                  # Strict TypeScript & JSON Schema data contracts
├── INTERVIEW_DEFENSE_GUIDE.md    # Technical interview defense guide & demo script
├── package.json                  # Test scripts and configuration
├── n8n/
│   └── workflows/
│       └── resilient-lead-pipeline-ghl.json  # Complete 19-node n8n workflow export
├── src/
│   ├── core/                     # Normalization, policy gates, and deduplication
│   ├── enrichment/               # Waterfall property cache adapter
│   ├── ghl/                      # GoHighLevel contact sync adapter
│   ├── ledger/                   # Two-sided mathematical reconciliation ledger
│   ├── security/                 # SHA-256 payload hashing and HMAC signatures
│   └── triage/                   # AI triage classification types
└── tests/
    └── pipeline.test.ts          # Automated integration test suite
```
│       └── resilient-lead-pipeline-ghl.json   # Verified 19-node, 4-group n8n workflow export
├── src/
│   ├── core/
│   │   ├── normalizer.ts         # E.164 phone, domain typo map, placeholder scrubbing
│   │   ├── gates.ts              # Trash gate, TCPA/DNC detector, commercial hub isolation
│   │   └── dedup.ts              # Tier 1 (Phone+Surname) & Tier 2 (Address+Surname) clustering
│   ├── security/
│   │   ├── signature.ts          # Timing-safe HMAC-SHA256 webhook verification
│   │   └── idempotency.ts        # Deterministic SHA-256 payload window guard
│   ├── enrichment/
│   │   └── waterfall.ts          # Local Cache ($0) -> Primary ($0.05) -> Fallback ($0.12)
│   ├── triage/
│   │   └── aiTriage.ts           # Strict JSON schema validator & confidence safety clamp
│   ├── ledger/
│   │   └── invariantLedger.ts    # Enforces Ingested = Processed + Duplicates + Quarantined + Failed
│   ├── ghl/
│   │   └── ghlClient.ts          # GoHighLevel v2 contact & pipeline stage mapper
│   └── pipeline.ts               # End-to-end batch & stream orchestrator
├── scripts/
│   └── run_sample_csv.ts         # 100-row historical CRM benchmark runner
└── tests/
    └── pipeline.test.ts          # 18 automated unit & integration tests
```

---

## Running Tests & Benchmarks Locally

```bash
# Run the 18 automated unit and invariant tests
npm test

# Run the 100-row historical CSV benchmark
node --experimental-strip-types scripts/run_sample_csv.ts
```
