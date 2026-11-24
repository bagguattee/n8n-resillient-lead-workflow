export type JobTypeCategory = 
  | 'REPLACEMENT'
  | 'REPAIR'
  | 'INSPECTION'
  | 'MAINTENANCE'
  | 'GENERAL_ENQUIRY';

export type LeadStatus = 
  | 'NEW'
  | 'ACTIVE'
  | 'WON'
  | 'LOST'
  | 'DEAD'
  | 'QUOTE_SENT'
  | 'INSPECTION_COMPLETED';

export interface RawLeadPayload {
  lead_id?: string;
  source?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  phone?: string;
  mobile_phone?: string;
  email?: string;
  street_address?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  job_type?: string;
  estimated_value?: number | string;
  lead_status?: string;
  compliance_opt_out?: boolean | string;
  contact_date?: string;
  notes?: string;
  submitted_at?: string;
  custom_fields?: Record<string, unknown>;
}

export interface NormalizedLead {
  raw_id: string;
  payload_hash: string;
  first_name: string;
  last_name: string;
  full_name: string;
  phone_e164: string | null;
  secondary_phone_e164?: string | null;
  email: string | null;
  secondary_email?: string | null;
  street_address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  job_type: JobTypeCategory;
  estimated_value: number;
  lead_status: LeadStatus;
  is_dnc: boolean;
  is_trash: boolean;
  contact_date: Date;
  submitted_at: Date;
  is_quarantined: boolean;
  quarantine_reason?: string;
}

export interface MasterLeadRecord extends NormalizedLead {
  master_id: string;
  merged_lead_ids: string[];
  additional_phones: string[];
  additional_emails: string[];
  additional_addresses: string[];
  household_key?: string;
  matched_rule?: 'TIER_1_CONTACT' | 'TIER_2_HOUSEHOLD' | 'NONE';
  is_hub_identifier: boolean;
  enrichment?: EnrichmentResult;
  ai_triage?: AiTriageResult;
  created_at: Date;
  updated_at: Date;
}

export interface EnrichmentData {
  property_type?: string;
  roof_square_footage?: number;
  year_built?: number;
  estimated_home_value?: number;
  homeowner_confirmed?: boolean;
  credit_tier?: string;
}

export interface EnrichmentResult {
  provider: 'LOCAL_CACHE' | 'PRIMARY_API' | 'FALLBACK_API';
  cost_cents: number;
  duration_ms: number;
  data: EnrichmentData;
  cached: boolean;
}

export interface AiTriageResult {
  urgency: 1 | 2 | 3 | 4 | 5;
  intent_category: 'IMMEDIATE_STORM_DAMAGE' | 'SCHEDULED_REPLACEMENT' | 'MINOR_REPAIR' | 'PRICE_SHOPPING' | 'SPAM_OR_GENERAL';
  confidence_score: number;
  qualification_status: 'QUALIFIED' | 'REVIEW_REQUIRED' | 'DISQUALIFIED';
  recommended_action: string;
  summary_for_sales: string;
}

export interface LedgerCounts {
  ingested: number;
  processed: number;
  duplicates: number;
  quarantined: number;
  failed: number;
}

export interface LedgerVerification {
  isBalanced: boolean;
  equation: string;
  discrepancy: number;
  ledger: LedgerCounts;
}
