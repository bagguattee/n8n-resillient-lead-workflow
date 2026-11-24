# Data Contracts & Invariants Specification

## 1. Overview
This document defines the strict, typed data contracts for **Resilient Lead Pipeline & GHL Centralization Hub** (Phase 3). 
It resolves the defects identified in the legacy Python v1 pipeline:
- No loose tuple guessing or untyped returns.
- Shared definitions of empty/invalid placeholders (`"idk"`, `"n/a"`, `"none"`, `""`, `null`).
- Explicit compliance and idempotency guarantees.

---

## 2. Inbound Webhook Contract

### Headers
| Header | Required | Description |
|---|---|---|
| `x-signature` | Yes (in production) | HMAC-SHA256 signature of the raw request payload using the configured webhook secret. |
| `x-idempotency-key` | Optional | Client-specified idempotency key (defaults to SHA-256 hash of payload). |

### Raw Ingestion Payload Schema (`RawLeadPayload`)
```typescript
export interface RawLeadPayload {
  lead_id?: string;
  source?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  phone?: string;
  email?: string;
  street_address?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  job_type?: string;
  estimated_value?: number | string;
  lead_status?: string;
  compliance_opt_out?: boolean | string;
  notes?: string;
  submitted_at?: string;
  custom_fields?: Record<string, unknown>;
}
```

---

## 3. Normalized Record Contract (`NormalizedLead`)

```typescript
export interface NormalizedLead {
  raw_id: string;
  payload_hash: string;
  first_name: string;
  last_name: string;
  full_name: string;
  phone_e164: string | null;       // Standard E.164 (e.g. +13035550192)
  email: string | null;            // Lowercase, trimmed, domain-corrected
  street_address: string | null;
  city: string | null;
  state: string | null;            // 2-letter uppercase ISO / US state
  postal_code: string | null;
  job_type: string;                // Normalized category (e.g. REPLACEMENT, REPAIR)
  estimated_value: number;         // Safe numeric representation
  lead_status: string;             // Standard enum: NEW, ACTIVE, WON, LOST, DEAD
  is_dnc: boolean;                 // Compliance flag
  quarantine_reason?: string;      // Non-empty if flagged as trash/DNC
  is_quarantined: boolean;
  submitted_at: Date;
}
```

---

## 4. Entity Resolution & Deduplication Contract

```typescript
export interface MasterLeadRecord extends NormalizedLead {
  master_id: string;
  merged_lead_ids: string[];
  additional_phones: string[];
  additional_emails: string[];
  additional_addresses: string[];
  household_key?: string;
  tier_matched?: 'TIER_1_CONTACT' | 'TIER_2_HOUSEHOLD' | 'NONE';
  is_hub_identifier: boolean;
  created_at: Date;
  updated_at: Date;
}
```

---

## 5. Waterfall Enrichment Contract

```typescript
export interface EnrichmentResult {
  provider: 'LOCAL_CACHE' | 'PRIMARY_API' | 'FALLBACK_API';
  cost_cents: number;
  duration_ms: number;
  data: {
    property_type?: string;
    roof_square_footage?: number;
    year_built?: number;
    estimated_home_value?: number;
    homeowner_confirmed?: boolean;
    credit_tier?: string;
  };
  cached: boolean;
}
```

---

## 6. AI Triage Contract

```typescript
export interface AiTriageResult {
  urgency: 1 | 2 | 3 | 4 | 5;
  intent_category: 'IMMEDIATE_STORM_DAMAGE' | 'SCHEDULED_REPLACEMENT' | 'MINOR_REPAIR' | 'PRICE_SHOPPING' | 'SPAM_OR_GENERAL';
  confidence_score: number;        // 0.00 to 1.00
  qualification_status: 'QUALIFIED' | 'REVIEW_REQUIRED' | 'DISQUALIFIED';
  recommended_action: string;
  summary_for_sales: string;
}
```

---

## 7. The Reconciliation Invariant Ledger

The pipeline enforces a mathematical invariant at the conclusion of every execution batch or stream window:

$$\text{Ingested Count} = \text{Processed} + \text{Duplicates Merged} + \text{Quarantined} + \text{Failed}$$

Any deviation triggers an immediate anomaly alert and fails the batch audit run.
