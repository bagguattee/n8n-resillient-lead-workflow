import { isPlaceholder, JUNK_PLACEHOLDERS } from './normalizer.ts';
import type { NormalizedLead, RawLeadPayload } from '../types/index.ts';

export interface TrashCheckResult {
  isTrash: boolean;
  reason: string;
}

const NON_VIABLE_STATUSES = new Set(['canceled', 'cancelled', 'voided', 'disputed', 'lost_bid', 'dead']);

export function checkIfTrash(
  raw: RawLeadPayload, 
  cleanedPhone: string | null, 
  cleanedEmail: string | null
): TrashCheckResult {
  // 1. Missing both phone and email
  if (!cleanedPhone && !cleanedEmail) {
    return {
      isTrash: true,
      reason: 'Missing both valid Phone and Email fields',
    };
  }

  // 2. Strict name check
  const first = (raw.first_name || '').trim().toLowerCase();
  const last = (raw.last_name || '').trim().toLowerCase();

  if (JUNK_PLACEHOLDERS.has(first) || JUNK_PLACEHOLDERS.has(last)) {
    return {
      isTrash: true,
      reason: `Gibberish or test lead indicator in name: '${raw.first_name} ${raw.last_name}'`,
    };
  }

  if (!first && !last && !raw.full_name) {
    return {
      isTrash: true,
      reason: 'Lead has no identifiable name provided',
    };
  }

  // 3. Status check
  const statusStr = String(raw.lead_status || '').trim().toLowerCase();
  for (const nonViable of NON_VIABLE_STATUSES) {
    if (statusStr.includes(nonViable)) {
      return {
        isTrash: true,
        reason: `Non-viable status detected: ${raw.lead_status}`,
      };
    }
  }

  return { isTrash: false, reason: '' };
}

export function checkDncCompliance(raw: RawLeadPayload): { isDnc: boolean; reason?: string } {
  const dncKeywords = ['dnc', 'do not call', 'unsubscribe', 'do_not_call', 'do_not_market', 'stop'];

  // Check explicit compliance fields
  if (raw.compliance_opt_out !== undefined && raw.compliance_opt_out !== null) {
    const optStr = String(raw.compliance_opt_out).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'dnc'].includes(optStr)) {
      return { isDnc: true, reason: 'Explicit compliance opt-out toggle flagged' };
    }
  }

  // Check notes or custom fields
  const textToCheck = [raw.notes || '', JSON.stringify(raw.custom_fields || {})].join(' ').toLowerCase();
  for (const kw of dncKeywords) {
    if (textToCheck.includes(kw)) {
      return { isDnc: true, reason: `Compliance keyword detected in payload: '${kw}'` };
    }
  }

  return { isDnc: false };
}

/**
 * Identifies shared communication hubs (phones or emails appearing across > threshold households).
 * Prevents shared broker, office, or tracking lines from merging strangers.
 */
export function identifyHubs(leads: NormalizedLead[], threshold = 3): { hubPhones: Set<string>; hubEmails: Set<string> } {
  const phoneToHouseholds = new Map<string, Set<string>>();
  const emailToHouseholds = new Map<string, Set<string>>();

  for (const lead of leads) {
    const householdId = `${lead.last_name || 'UNKNOWN'}_${lead.street_address || lead.postal_code || 'N/A'}`.toLowerCase();

    if (lead.phone_e164) {
      if (!phoneToHouseholds.has(lead.phone_e164)) {
        phoneToHouseholds.set(lead.phone_e164, new Set());
      }
      phoneToHouseholds.get(lead.phone_e164)!.add(householdId);
    }

    if (lead.email) {
      if (!emailToHouseholds.has(lead.email)) {
        emailToHouseholds.set(lead.email, new Set());
      }
      emailToHouseholds.get(lead.email)!.add(householdId);
    }
  }

  const hubPhones = new Set<string>();
  const hubEmails = new Set<string>();

  for (const [phone, households] of phoneToHouseholds.entries()) {
    if (households.size > threshold) {
      hubPhones.add(phone);
    }
  }

  for (const [email, households] of emailToHouseholds.entries()) {
    if (households.size > threshold) {
      hubEmails.add(email);
    }
  }

  return { hubPhones, hubEmails };
}
