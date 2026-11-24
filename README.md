# Resilient Lead Pipeline & GHL Centralization Hub (Phase 3)

An enterprise data hygiene, entity resolution, and AI lead triage engine built with **n8n** and **TypeScript**. It ingests messy inbound home-services leads, enforces E.164 & domain hygiene, isolates TCPA/DNC opt-outs into an immutable Quarantine Audit Ledger + GoHighLevel DND hold, performs cost-tracked waterfall property enrichment, runs a live **Groq LLM (`openai/gpt-oss-120b`) Information Extractor**, and enforces a strict mathematical Reconciliation Invariant Ledger.

---

## Architecture & n8n Node Groups

The production n8n workflow ([resilient-lead-pipeline-ghl.json](n8n/workflows/resilient-lead-pipeline-ghl.json)) is organized into **4 modular Node Groups** following official n8n architectural standards:

```
                      [Inbound Lead Webhook] (POST /webhook/lead-ingest)
                                │
                                ▼
       ┌────────────────────────────────────────────────────────┐
       │ Group 1: Verify & Normalize Payload                    │
       │  • Compute Payload Hash (Native SHA-256 Crypto Node)   │
       │  • Normalize and Scrub Lead Fields (In-Process IIFE)   │
       │    - Strips Excel .0 floats -> E.164 (+13035550192)    │
       │    - Auto-fixes domain typos (gamil.com -> gmail.com)  │
       │    - Scrubs placeholders ("idk", "n/a", "0000000000")  │
       │  • Is Signature Valid? (401 Responder on tamper)       │
       └────────────────────────┬───────────────────────────────┘
                                │
                                ▼
                   [Passes Policy and DNC Gates?]
                                │
          ┌─────────────────────┴─────────────────────┐
          ▼ (False: DNC / Burner / Trash)             ▼ (True: Viable & Compliant)
┌───────────────────────────────────────────┐  ┌────────────────────────────────────────────┐
│ Group 2: Quarantine & Compliance Hold     │  │ Group 3: Waterfall Enrichment & AI Triage  │
│  • Record Quarantine in Ledger (Table)    │  │  • Lookup Property Cache (Data Table $0)   │
│  • Append Quarantine Audit Log (Table)    │  │  • Resolve Waterfall Enrichment            │
│  • Sync GHL Compliance Hold (dnd: true)   │  │    ($0.00 Cache -> $0.05 Primary -> $0.12) │
│  • Respond 202 Quarantined                │  │  • AI Lead Triage Extractor (Groq LLM)     │
└───────────────────────────────────────────┘  └──────────────────────┬─────────────────────┘
                                                                      │
                                                                      ▼
                                               ┌────────────────────────────────────────────┐
                                               │ Group 4: GHL Dispatch & Reconciliation     │
                                               │  • Is High Urgency Lead?                   │
                                               │    (urgency >= 4 AND confidence >= 0.70)   │
                                               │    ├── True  -> GHL Hot Priority Route     │
                                               │    └── False -> GHL Standard / HITL Route  │
                                               │  • Record Processed Lead in Ledger (Table) │
                                               │  • Respond 200 Lead Processed              │
                                               └────────────────────────────────────────────┘
```

---

## Live n8n Data Tables & Verification Results

The workflow persists state across **3 built-in n8n Data Tables** and was verified end-to-end against 4 representative production payloads:

### 1. `Lead Reconciliation Ledger` (4 Ingested = 2 Processed + 2 Quarantined, 0 Discrepancy)

| `leadId` | `fullName` | `phoneE164` | `email` | `ledgerStatus` | `aiUrgency` | `intentCategory` | `enrichmentProvider` | `costCents` | `ghlRoute` |
|---|---|---|---|---|---|---|---|---|---|
| `LEAD_2026_001` | Marcus Vance | `+13035550192` *(from `.0` float)* | `marcus.vance@gmail.com` *(from `gamil.com`)* | **`PROCESSED`** | `5` | `IMMEDIATE_STORM_DAMAGE` | `LOCAL_CACHE` | `0` | `HOT_PRIORITY_DISPATCH` |
| `LEAD_2026_002` | Mark Smith | `+15559990000` | `mark@smith.com` | **`QUARANTINED`** | `0` | `QUARANTINED` | `NONE` | `0` | `QUARANTINE_COMPLIANCE_HOLD` |
| `LEAD_2026_003` | Sarah Jenkins | `+13035558877` | `sarah.j@yahoo.com` *(from `yahoocom`)* | **`PROCESSED`** | `3` | `MINOR_REPAIR` | `PRIMARY_API` | `5` | `STANDARD_NURTURE` |
| `LEAD_2026_004` | UNIDENTIFIED *(from `"idk test"`)* | `""` *(from `"0000000000"`)* | `fakelead@mailinator.com` | **`QUARANTINED`** | `0` | `QUARANTINED` | `NONE` | `0` | `QUARANTINE_COMPLIANCE_HOLD` |

### 2. `Quarantine TCPA Audit Log`

| `leadId` | `fullName` | `email` | `quarantineReason` | `ghlDndSynced` |
|---|---|---|---|---|
| `LEAD_2026_002` | Mark Smith | `mark@smith.com` | `[DNC] Explicit TCPA opt-out or DNC compliance keyword detected` | `true` |
| `LEAD_2026_004` | UNIDENTIFIED | `fakelead@mailinator.com` | `[DISPOSABLE] Burner email domain blocked` | `true` |

### 3. `Property Enrichment Cache`

| `lookupKey` | `propertyType` | `roofSquareFootage` | `yearBuilt` | `estimatedHomeValue` | `isHomeownerConfirmed` |
|---|---|---|---|---|---|
| `123 main st` | `Single Family` | `3400` | `1998` | `685000` | `true` |

---

## Key Engineering Highlights (v1 Python $\rightarrow$ v2 TypeScript + n8n)

| Legacy v1 Defect | Modernized v2 Resolution | Business Impact |
|---|---|---|
| **Placeholder Leaks**: `"idk"`, `"n/a"` slipped into clean CRM exports | Centralized `isPlaceholder` & IIFE normalizer scrubbing | Dirty placeholders become typed `null` / empty strings and trigger quarantine when contact channels are missing. |
| **Sandboxed Code Node Overhead**: Using JS Code nodes for `require('crypto')` and field mapping | Native **`n8n-nodes-base.crypto`** (`SHA-256`) + in-process **Edit Fields (`Set`) IIFE expressions** | Cuts per-item normalization latency from ~300–600ms down to ~8–30ms. |
| **Blind AI Triage**: LLM only saw customer's short message | **Enrichment-Augmented Prompting**: Waterfall property facts (`roofSquareFootage`, `estimatedHomeValue`) are injected into the **Information Extractor** | AI accurately prioritizes high-value properties even when the homeowner writes a brief message. |
| **Compliance Leakage**: High-value deals bypassed DNC checks | **Compliance Overrides Revenue**: Any DNC flag routes immediately to `Quarantine & Compliance Hold` and syncs `dnd: true` to GoHighLevel | Protects the business from \$500–\$1,500/text TCPA penalties. |
| **Commercial Hub Pollution**: Shared broker/office numbers merged strangers | Multi-household hub detector (`identifyHubs` >3 households) in TypeScript engine | Prevents unrelated homeowners from collapsing into one contact record. |

---

## Repository Structure

```
resilient-lead-pipeline/
├── CONTRACTS.md                  # Strict TypeScript & JSON Schema data contracts
├── INTERVIEW_DEFENSE_GUIDE.md    # Technical interview Q&A and 3-minute live demo script
├── package.json                  # Zero-dependency Node 24 native TypeScript test runner
├── n8n/
│   └── workflows/
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
