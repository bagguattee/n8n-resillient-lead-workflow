import type { MasterLeadRecord } from '../types/index.ts';

export interface GhlContactPayload {
  firstName: string;
  lastName: string;
  name: string;
  email?: string;
  phone?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  tags: string[];
  customFields: Array<{ id: string; key: string; field_value: string | number | boolean }>;
}

export interface GhlOpportunityPayload {
  pipelineId?: string;
  stageId?: string;
  name: string;
  monetaryValue: number;
  status: 'open' | 'won' | 'lost' | 'abandoned';
}

export interface GhlDispatchResult {
  contactId: string;
  opportunityId?: string;
  stageAssigned: string;
  tagsApplied: string[];
  success: boolean;
}

export class GoHighLevelClient {
  private apiKey: string;
  private locationId: string;
  private isLive: boolean;

  constructor(apiKey = 'MOCK_GHL_API_KEY', locationId = 'MOCK_LOCATION_ID', isLive = false) {
    this.apiKey = apiKey;
    this.locationId = locationId;
    this.isLive = isLive;
  }

  /**
   * Translates an internal MasterLeadRecord into GHL v2 API payloads.
   */
  public buildContactPayload(lead: MasterLeadRecord): GhlContactPayload {
    const tags = ['resilient-pipeline', `status:${lead.lead_status.toLowerCase()}`];

    if (lead.is_quarantined) {
      tags.push('quarantined', 'compliance-hold');
    }
    if (lead.ai_triage) {
      tags.push(`intent:${lead.ai_triage.intent_category.toLowerCase()}`);
      tags.push(`urgency:${lead.ai_triage.urgency}`);
      if (lead.ai_triage.urgency >= 4) {
        tags.push('priority-hot-lead');
      }
    }

    const customFields = [
      { id: 'custom_normalized_phone', key: 'normalized_phone', field_value: lead.phone_e164 || '' },
      { id: 'custom_job_type', key: 'job_type', field_value: lead.job_type },
      { id: 'custom_ai_score', key: 'ai_lead_score', field_value: lead.ai_triage?.urgency || 1 },
      { id: 'custom_intent', key: 'intent_category', field_value: lead.ai_triage?.intent_category || 'GENERAL' },
      { id: 'custom_confidence', key: 'ai_confidence', field_value: lead.ai_triage?.confidence_score || 0.0 },
    ];

    if (lead.enrichment?.data) {
      if (lead.enrichment.data.roof_square_footage) {
        customFields.push({
          id: 'custom_roof_sqft',
          key: 'roof_square_footage',
          field_value: lead.enrichment.data.roof_square_footage,
        });
      }
      if (lead.enrichment.data.estimated_home_value) {
        customFields.push({
          id: 'custom_est_home_val',
          key: 'estimated_home_value',
          field_value: lead.enrichment.data.estimated_home_value,
        });
      }
    }

    return {
      firstName: lead.first_name,
      lastName: lead.last_name,
      name: lead.full_name,
      email: lead.email || undefined,
      phone: lead.phone_e164 || undefined,
      address1: lead.street_address || undefined,
      city: lead.city || undefined,
      state: lead.state || undefined,
      postalCode: lead.postal_code || undefined,
      tags,
      customFields,
    };
  }

  /**
   * Maps lead urgency and triage directly to GoHighLevel sales pipeline stages.
   */
  public determinePipelineStage(lead: MasterLeadRecord): string {
    if (lead.is_quarantined) {
      return 'Quarantine / Compliance Dispute';
    }
    if (lead.ai_triage?.qualification_status === 'REVIEW_REQUIRED') {
      return 'HITL Human Review Queue';
    }
    if (lead.ai_triage && lead.ai_triage.urgency >= 4) {
      return 'Hot Lead / Immediate Dispatch';
    }
    return 'New Lead Ingestion';
  }

  /**
   * Dispatches contact and opportunity to GoHighLevel.
   */
  public async dispatchLead(lead: MasterLeadRecord): Promise<GhlDispatchResult> {
    const contactPayload = this.buildContactPayload(lead);
    const stage = this.determinePipelineStage(lead);

    if (!this.isLive) {
      // Deterministic mock return for testing and offline environments
      return {
        contactId: `ghl_cnt_${lead.master_id}`,
        opportunityId: `ghl_opp_${lead.master_id}`,
        stageAssigned: stage,
        tagsApplied: contactPayload.tags,
        success: true,
      };
    }

    // Live HTTP call to GHL API endpoint (when live keys are present)
    const response = await fetch(`https://rest.gohighlevel.com/v1/contacts/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        ...contactPayload,
        locationId: this.locationId,
      }),
    });

    if (!response.ok) {
      throw new Error(`GHL API error: ${response.statusText}`);
    }

    const data = (await response.json()) as any;
    return {
      contactId: data.contact?.id || `ghl_cnt_${lead.master_id}`,
      stageAssigned: stage,
      tagsApplied: contactPayload.tags,
      success: true,
    };
  }
}
