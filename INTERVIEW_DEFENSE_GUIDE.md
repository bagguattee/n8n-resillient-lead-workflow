# Technical Interview Defense Guide: Resilient Lead Pipeline & GHL Hub

Use this reference during technical interviews, live Loom walkthroughs, or client discovery calls. Every design choice in this repository and n8n workflow maps to a concrete production failure mode.

---

## 1. The 30-Second Elevator Pitch

> *"Most CRM automations fail silently in production: they push dirty strings like `'idk'` or trailing Excel `.0` floats straight into phone fields, pay for duplicate enrichment lookups when webhooks retry, and accidentally text opted-out leads because they don't resolve identity across records. I built a two-layer system — a TypeScript Entity Resolution & Invariant Engine with 18 automated unit tests, paired with an n8n orchestration workflow backed by 3 Data Tables and a Groq-powered Information Extractor — that enforces E.164 hygiene, TCPA compliance isolation, cost-aware waterfall caching, and a strict Reconciliation Ledger before dispatching to GoHighLevel."*

---

## 2. Core Architectural Questions & Answers

### Q1: "Why didn't you just use a Code node in n8n for hashing and field normalization?"
* **Weak Answer:** *"I used Set nodes because they looked cleaner."*
* **Senior Answer:**
  1. **Performance & Sandbox Overhead:** In n8n, a JavaScript `Code` node spins up a sandboxed VM task runner (~200–600ms overhead per execution). By contrast, **Edit Fields (`Set`) with IIFE arrow function expressions (`{{ (() => { ... })() }}`)** runs in-process in **1–30ms** (up to 20x faster under burst webhook load).
  2. **Native Cryptography:** Using `require('crypto')` inside a Code node is an n8n anti-pattern that often breaks across task-runner sandboxes. I used the native **`n8n-nodes-base.crypto`** node (`SHA-256`) to generate deterministic payload hashes (`payloadHash`) in 8ms.
  3. **Refactor Safety:** Every downstream node references `$('Normalize and Scrub Lead Fields').item.json.<field>` by explicit node name rather than relative `$json`, so inserting intermediate nodes or converging branches never causes silent `undefined` field drift.

---

### Q2: "How does the Quarantine branch work, and why do you write to three places instead of just dropping bad leads?"
* **Senior Answer:**
  > *"Dropping a lead silently creates two liabilities: you can't prove TCPA compliance if a homeowner claims you texted them after an opt-out, and marketing loses visibility into why ad spend is producing junk leads. When a lead fails `Passes Policy and DNC Gates?`, the **`Quarantine & Compliance Hold`** node group executes three actions:"*
  1. **`Record Quarantine in Ledger` (`Lead Reconciliation Ledger` Data Table):** Logs the row with `ledgerStatus = 'QUARANTINED'` so the reconciliation invariant ($\text{Ingested} = \text{Processed} + \text{Duplicates} + \text{Quarantined} + \text{Failed}$) stays balanced at 0 discrepancy.
  2. **`Append Quarantine Audit Log` (`Quarantine TCPA Audit Log` Data Table / Google Sheets):** Records an immutable audit row with the exact `quarantineReason` (`[DNC]`, `[DISPOSABLE]`, or `[TRASH]`), timestamp, and SHA-256 `payloadHash`.
  3. **`Sync GHL Compliance Hold` (`POST /v1/contacts/`):** Pushes `"dnd": true` and tags `["compliance-quarantine", "do-not-contact", "dnc-isolated"]` to GoHighLevel so any existing contact record in the CRM is immediately muted across all active SMS/voice sequences.

---

### Q3: "Why do you run Waterfall Property Enrichment *before* the AI Lead Triage LLM?"
* **Senior Answer:**
  > *"Because customer text alone hides deal value. A homeowner might type five words: `'Need an estimate for roof.'` Text-only triage scores that as a low-priority general inquiry. By running **Waterfall Enrichment** first (`Lookup Property Cache` $\rightarrow$ `Resolve Waterfall Enrichment`), we inject physical property facts (`3,400 sq ft roof, built 1998, $685,000 home value`) directly into the **`AI Lead Triage Extractor`** prompt alongside the customer's notes. The LLM sees both urgency (from the text) and deal size (from the property cache), producing an executive brief that tells the rep why this lead is worth immediate attention."*

---

### Q4: "How does your Waterfall Enrichment control API costs?"
* **Senior Answer:**
  > *"Enrichment APIs charge $0.05 to $0.15 per lookup. If a homeowner submits a form twice or we already quoted their street address, paying again is wasted margin. My waterfall checks **`Lookup Property Cache`** (an n8n Data Table indexed by normalized `lookupKey`) first at **$0.00 cost**. Only on a cache miss (`cached: false`) does `Resolve Waterfall Enrichment` fall back to `PRIMARY_API` ($0.05) or `FALLBACK_API` ($0.12), logging the exact `enrichmentCostCents` and `enrichmentProvider` into the `Lead Reconciliation Ledger`."*

---

### Q5: "What happens if the LLM hallucinates or gets a vague, ambiguous message?"
* **Senior Answer:**
  > *"Two guardrails prevent bad AI outputs from firing automated outreach:"*
  1. **Schema-Constrained Extraction:** Instead of a free-form chat prompt, I use n8n's **`Information Extractor`** (`@n8n/n8n-nodes-langchain.informationExtractor`) connected to Groq (`openai/gpt-oss-120b` at `temperature: 0.1`), which enforces a strict JSON Schema (`urgency` 1–5, `intent_category` enum, `confidence_score` 0.0–1.0, `qualification_status`, `summary_for_sales`).
  2. **Confidence Demotion Gate (`Is High Urgency Lead?`):** To qualify for the hot priority route, a lead must pass **both** `urgency >= 4` **AND** `confidence_score >= 0.70`. If `confidence_score < 0.70`, the lead is automatically tagged `hitl-human-review-queue` so a human coordinator reviews it before any automated SMS fires.

---

### Q6: "Why do you have both a TypeScript repository (`src/`) and an n8n workflow (`n8n/workflows/`)?"
* **Senior Answer:**
  > *"In production, n8n excels at visual orchestration, webhook routing, credential management, and LLM chaining, while multi-pass entity resolution across thousands of historical CRM rows (Tier 1 Phone+Surname clustering, Tier 2 Address+Surname clustering, 5-year recency demotion, and >3-household commercial hub sandboxing) belongs in a strongly-typed microservice backed by unit tests (`npm test` runs 18 assertions in <50ms). Having both proves I can build the visual n8n orchestration layer AND the underlying TypeScript data engineering engine."*

---

## 3. Live Demo Script (3-Minute Loom / Screen Share)

1. **Show the n8n Canvas (`http://localhost:5678/workflow/jCIgGQFTz0bUVKe3`):**
   - Point out the 4 clean **Node Groups**:
     - `Verify & Normalize Payload`
     - `Quarantine & Compliance Hold`
     - `Waterfall Enrichment & AI Triage`
     - `GHL Dispatch & Ledger Reconciliation`
2. **Show the Live Executions Tab:**
   - **Execution #3 (`LEAD_2026_001` - Marcus Vance):** Show how `(303) 555-0192.0` became `+13035550192`, `marcus.vance@gamil.com` became `marcus.vance@gmail.com`, `123 Main St` hit `LOCAL_CACHE` at `$0.00`, and Groq LLM scored `urgency: 5` (`IMMEDIATE_STORM_DAMAGE`).
   - **Execution #4 (`LEAD_2026_002` - Mark Smith):** Show how an `$18,000` replacement deal with `compliance_opt_out: true` was intercepted by `Passes Policy and DNC Gates?` and routed to `Quarantine & Compliance Hold`.
   - **Execution #5 (`LEAD_2026_003` - Sarah Jenkins):** Show how an uncached address (`742 Evergreen Terrace`) missed local cache, fell back to `PRIMARY_API` (`5 cents`), and was scored by Groq LLM as `urgency: 3` (`MINOR_REPAIR`).
3. **Show the n8n Data Tables (`Lead Reconciliation Ledger` & `Quarantine TCPA Audit Log`):**
   - Open the **Data Tables** tab in n8n and show the 4 live ingested rows (`2 PROCESSED + 2 QUARANTINED = 4 Ingested`, 0 discrepancy).
4. **Show the Terminal (`npm test`):**
   - Run `npm test` to show 18/18 TypeScript unit tests passing in under 50ms.
