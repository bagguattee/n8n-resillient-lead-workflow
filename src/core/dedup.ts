import type { MasterLeadRecord, NormalizedLead } from '../types/index.ts';
import { identifyHubs } from './gates.ts';

const FIVE_YEARS_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

export interface DedupAuditLogEntry {
  cluster_id: string;
  merged_id: string;
  matched_tier: 'TIER_1_CONTACT' | 'TIER_2_HOUSEHOLD';
  match_key: string;
  reason: string;
  timestamp: Date;
}

export interface DedupResult {
  masters: MasterLeadRecord[];
  quarantined: MasterLeadRecord[];
  auditLogs: DedupAuditLogEntry[];
  totalMergedCount: number;
}

function normalizeAddressKey(addr: string | null): string {
  if (!addr) return '';
  return addr
    .toLowerCase()
    .replace(/\b(street|st\.?)\b/g, 'st')
    .replace(/\b(avenue|ave\.?)\b/g, 'ave')
    .replace(/\b(road|rd\.?)\b/g, 'rd')
    .replace(/\b(drive|dr\.?)\b/g, 'dr')
    .replace(/\b(lane|ln\.?)\b/g, 'ln')
    .replace(/\b(boulevard|blvd\.?)\b/g, 'blvd')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function deduplicateLeads(leads: NormalizedLead[]): DedupResult {
  // 1. Identify shared hub identifiers (>3 distinct households)
  const { hubPhones, hubEmails } = identifyHubs(leads);

  // Clusters of lead records
  const clusters: NormalizedLead[][] = [];
  const auditLogs: DedupAuditLogEntry[] = [];

  // Index maps for fast clustering
  const phoneIndex = new Map<string, number>(); // phone_lastName -> clusterIdx
  const addressIndex = new Map<string, number>(); // address_lastName -> clusterIdx

  for (const lead of leads) {
    let matchedClusterIdx: number | null = null;
    let matchedTier: 'TIER_1_CONTACT' | 'TIER_2_HOUSEHOLD' | null = null;
    let matchKey = '';

    const lastNameKey = (lead.last_name || '').toLowerCase().trim();
    const isHubPhone = lead.phone_e164 && hubPhones.has(lead.phone_e164);

    // --- TIER 1 CHECK: Phone + Last Name (Sandboxed if hub) ---
    const phonesToCheck = [lead.phone_e164, lead.secondary_phone_e164].filter(Boolean) as string[];

    for (const p of phonesToCheck) {
      if (p && lastNameKey && !hubPhones.has(p)) {
        const tier1Key = `${p}#${lastNameKey}`;
        if (phoneIndex.has(tier1Key)) {
          const candidateIdx = phoneIndex.get(tier1Key)!;
          const candidateLead = clusters[candidateIdx]![0]!;
          
          const timeDiff = Math.abs(lead.contact_date.getTime() - candidateLead.contact_date.getTime());
          if (timeDiff <= FIVE_YEARS_MS) {
            matchedClusterIdx = candidateIdx;
            matchedTier = 'TIER_1_CONTACT';
            matchKey = tier1Key;
            break;
          }
        }
      }
    }

    // --- TIER 2 CHECK: Street Address + Last Name (if not matched in Tier 1) ---
    const cleanAddrKey = normalizeAddressKey(lead.street_address);
    if (matchedClusterIdx === null && cleanAddrKey && lastNameKey) {
      const tier2Key = `${cleanAddrKey}#${lastNameKey}`;
      if (addressIndex.has(tier2Key)) {
        const candidateIdx = addressIndex.get(tier2Key)!;
        const candidateLead = clusters[candidateIdx]![0]!;

        const timeDiff = Math.abs(lead.contact_date.getTime() - candidateLead.contact_date.getTime());
        if (timeDiff <= FIVE_YEARS_MS) {
          matchedClusterIdx = candidateIdx;
          matchedTier = 'TIER_2_HOUSEHOLD';
          matchKey = tier2Key;
        }
      }
    }

    // Process clustering
    if (matchedClusterIdx !== null && matchedTier !== null) {
      // Add to existing cluster
      clusters[matchedClusterIdx]!.push(lead);
      auditLogs.push({
        cluster_id: clusters[matchedClusterIdx]![0]!.raw_id,
        merged_id: lead.raw_id,
        matched_tier: matchedTier,
        match_key: matchKey,
        reason: `Matched via ${matchedTier} on key '${matchKey}' within 5-year window`,
        timestamp: new Date(),
      });
    } else {
      // Create new cluster
      const newClusterIdx = clusters.length;
      clusters.push([lead]);

      // Register index keys if valid and not a hub
      for (const p of phonesToCheck) {
        if (p && lastNameKey && !hubPhones.has(p)) {
          phoneIndex.set(`${p}#${lastNameKey}`, newClusterIdx);
        }
      }
      if (cleanAddrKey && lastNameKey) {
        addressIndex.set(`${cleanAddrKey}#${lastNameKey}`, newClusterIdx);
      }
    }
  }

  // Build Master Records from clusters
  const masters: MasterLeadRecord[] = [];
  const quarantined: MasterLeadRecord[] = [];
  let totalMergedCount = 0;

  for (const cluster of clusters) {
    if (cluster.length > 1) {
      totalMergedCount += cluster.length - 1;
    }

    // Primary record is the most recent or highest value record
    const primary = cluster.reduce((best, curr) => {
      if (curr.contact_date.getTime() > best.contact_date.getTime()) return curr;
      if (curr.contact_date.getTime() === best.contact_date.getTime() && curr.estimated_value > best.estimated_value) return curr;
      return best;
    }, cluster[0]!);

    // Aggregate secondary data
    const additionalPhones = new Set<string>();
    const additionalEmails = new Set<string>();
    const additionalAddresses = new Set<string>();
    const mergedIds: string[] = [];

    let clusterIsDnc = false;
    let clusterIsQuarantined = false;
    let quarantineReason = primary.quarantine_reason || '';
    let totalEstimatedValue = 0;

    for (const record of cluster) {
      mergedIds.push(record.raw_id);
      totalEstimatedValue += record.estimated_value;

      // TCPA / DNC COMPLIANCE OVERRIDE:
      // If ANY record in this cluster opted out or is flagged DNC, the entire cluster is quarantined
      if (record.is_dnc) {
        clusterIsDnc = true;
        clusterIsQuarantined = true;
        quarantineReason = 'DNC opt-out present in merged cluster (compliance overrides revenue)';
      }

      if (record.is_quarantined) {
        clusterIsQuarantined = true;
        if (!quarantineReason) quarantineReason = record.quarantine_reason || 'Quarantined record in cluster';
      }

      if (record.phone_e164 && record.phone_e164 !== primary.phone_e164) {
        additionalPhones.add(record.phone_e164);
      }
      if (record.email && record.email !== primary.email) {
        additionalEmails.add(record.email);
      }
      if (record.secondary_email && record.secondary_email !== primary.email) {
        additionalEmails.add(record.secondary_email);
      }
      if (record.street_address && record.street_address !== primary.street_address) {
        additionalAddresses.add(record.street_address);
      }
    }

    const isHub = !!(
      (primary.phone_e164 && hubPhones.has(primary.phone_e164)) ||
      (primary.email && hubEmails.has(primary.email))
    );

    const masterRecord: MasterLeadRecord = {
      ...primary,
      master_id: `mst_${primary.raw_id}`,
      estimated_value: totalEstimatedValue,
      is_dnc: clusterIsDnc,
      is_quarantined: clusterIsQuarantined,
      quarantine_reason: clusterIsQuarantined ? quarantineReason : undefined,
      merged_lead_ids: mergedIds,
      additional_phones: Array.from(additionalPhones),
      additional_emails: Array.from(additionalEmails),
      additional_addresses: Array.from(additionalAddresses),
      is_hub_identifier: isHub,
      created_at: primary.submitted_at,
      updated_at: new Date(),
    };

    if (masterRecord.is_quarantined) {
      quarantined.push(masterRecord);
    } else {
      masters.push(masterRecord);
    }
  }

  return {
    masters,
    quarantined,
    auditLogs,
    totalMergedCount,
  };
}
