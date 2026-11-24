import type { AiTriageResult, NormalizedLead, RawLeadPayload } from '../types/index.ts';

export const AI_TRIAGE_JSON_SCHEMA = {
  type: 'object',
  required: [
    'urgency',
    'intent_category',
    'confidence_score',
    'qualification_status',
    'recommended_action',
    'summary_for_sales',
  ],
  properties: {
    urgency: { type: 'integer', minimum: 1, maximum: 5 },
    intent_category: {
      type: 'string',
      enum: [
        'IMMEDIATE_STORM_DAMAGE',
        'SCHEDULED_REPLACEMENT',
        'MINOR_REPAIR',
        'PRICE_SHOPPING',
        'SPAM_OR_GENERAL',
      ],
    },
    confidence_score: { type: 'number', minimum: 0.0, maximum: 1.0 },
    qualification_status: {
      type: 'string',
      enum: ['QUALIFIED', 'REVIEW_REQUIRED', 'DISQUALIFIED'],
    },
    recommended_action: { type: 'string' },
    summary_for_sales: { type: 'string' },
  },
};

/**
 * Validates and safely casts raw JSON string (e.g. from Claude Haiku / LLM node)
 * into strict typed AiTriageResult.
 */
export function parseAndValidateAiTriage(rawResponse: string | unknown): AiTriageResult {
  let parsed: Record<string, unknown>;

  if (typeof rawResponse === 'string') {
    // Strip markdown fences if present
    const cleaned = rawResponse
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/g, '')
      .trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return getFallbackTriage('Failed to parse AI JSON response');
    }
  } else if (rawResponse && typeof rawResponse === 'object') {
    parsed = rawResponse as Record<string, unknown>;
  } else {
    return getFallbackTriage('Invalid response format');
  }

  // Validate and clamp urgency (1-5)
  const rawUrgency = parseInt(String(parsed.urgency), 10);
  const urgency = isNaN(rawUrgency) ? 3 : (Math.min(Math.max(rawUrgency, 1), 5) as 1 | 2 | 3 | 4 | 5);

  // Validate intent_category
  const validIntents = [
    'IMMEDIATE_STORM_DAMAGE',
    'SCHEDULED_REPLACEMENT',
    'MINOR_REPAIR',
    'PRICE_SHOPPING',
    'SPAM_OR_GENERAL',
  ] as const;
  const intent_category = validIntents.includes(parsed.intent_category as any)
    ? (parsed.intent_category as AiTriageResult['intent_category'])
    : 'SPAM_OR_GENERAL';

  // Validate confidence_score
  const rawConf = parseFloat(String(parsed.confidence_score));
  const confidence_score = isNaN(rawConf) ? 0.5 : Math.min(Math.max(rawConf, 0.0), 1.0);

  // Validate qualification_status
  const validQuals = ['QUALIFIED', 'REVIEW_REQUIRED', 'DISQUALIFIED'] as const;
  let qualification_status: AiTriageResult['qualification_status'] = validQuals.includes(parsed.qualification_status as any)
    ? (parsed.qualification_status as AiTriageResult['qualification_status'])
    : 'REVIEW_REQUIRED';

  // Edge case safety guard: If confidence is low (< 0.70), auto-demote to REVIEW_REQUIRED
  if (confidence_score < 0.70 && qualification_status === 'QUALIFIED') {
    qualification_status = 'REVIEW_REQUIRED';
  }

  return {
    urgency,
    intent_category,
    confidence_score,
    qualification_status,
    recommended_action: String(parsed.recommended_action || 'Review lead details manually in CRM.'),
    summary_for_sales: String(parsed.summary_for_sales || 'Automated AI triage summary generated.'),
  };
}

/**
 * Deterministic heuristic evaluator used for local testing or LLM network dropouts.
 */
export function evaluateLeadHeuristics(lead: NormalizedLead | RawLeadPayload): AiTriageResult {
  const notes = String(lead.notes || '').toLowerCase();
  const job = String(lead.job_type || '').toLowerCase();
  const value = typeof lead.estimated_value === 'number' ? lead.estimated_value : 0;

  // 1. Storm / Emergency Leaks
  if (notes.includes('emergency') || notes.includes('active leak') || notes.includes('storm') || notes.includes('hail')) {
    return {
      urgency: 5,
      intent_category: 'IMMEDIATE_STORM_DAMAGE',
      confidence_score: 0.95,
      qualification_status: 'QUALIFIED',
      recommended_action: 'Immediate dispatch / Same-day phone call from rapid response rep',
      summary_for_sales: 'High-urgency storm damage or active leak reported by homeowner.',
    };
  }

  // 2. High-value replacement
  if (job.includes('replacement') || value >= 8000) {
    return {
      urgency: 4,
      intent_category: 'SCHEDULED_REPLACEMENT',
      confidence_score: 0.88,
      qualification_status: 'QUALIFIED',
      recommended_action: 'Schedule on-site roof inspection within 24 hours',
      summary_for_sales: `High-ticket roof replacement prospect with estimated value of $${value.toLocaleString()}.`,
    };
  }

  // 3. Minor repair
  if (job.includes('repair') || notes.includes('shingle') || notes.includes('gutter')) {
    return {
      urgency: 3,
      intent_category: 'MINOR_REPAIR',
      confidence_score: 0.82,
      qualification_status: 'QUALIFIED',
      recommended_action: 'Send standard repair estimate booking link via SMS',
      summary_for_sales: 'Standard residential repair enquiry.',
    };
  }

  // 4. Price shopping
  if (notes.includes('ballpark') || notes.includes('quote only') || notes.includes('cheapest')) {
    return {
      urgency: 2,
      intent_category: 'PRICE_SHOPPING',
      confidence_score: 0.75,
      qualification_status: 'REVIEW_REQUIRED',
      recommended_action: 'Enter automated nurture email sequence with pricing guide',
      summary_for_sales: 'Lead is comparing contractor quotes; nurture before live rep call.',
    };
  }

  // Fallback
  return {
    urgency: 2,
    intent_category: 'SPAM_OR_GENERAL',
    confidence_score: 0.65,
    qualification_status: 'REVIEW_REQUIRED',
    recommended_action: 'Manual review required by sales coordinator',
    summary_for_sales: 'General enquiry lacking specific roof damage or project scope.',
  };
}

function getFallbackTriage(reason: string): AiTriageResult {
  return {
    urgency: 3,
    intent_category: 'SPAM_OR_GENERAL',
    confidence_score: 0.4,
    qualification_status: 'REVIEW_REQUIRED',
    recommended_action: `Manual verification needed: ${reason}`,
    summary_for_sales: 'Automated parser could not resolve AI output format.',
  };
}
