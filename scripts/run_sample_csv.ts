import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ResilientLeadPipelineEngine } from '../src/pipeline.ts';
import type { RawLeadPayload } from '../src/types/index.ts';

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) return [];

  // Parse CSV header
  const headers = parseCsvLine(lines[0]!);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]!);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = values[idx] !== undefined ? values[idx].trim() : '';
    });
    rows.push(row);
  }

  return rows;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

async function run() {
  const candidatePaths = [
    resolve(process.cwd(), '../roofing-pipeline-v1/raw_leads.csv'),
    resolve(process.cwd(), 'roofing-pipeline-v1/raw_leads.csv'),
  ];

  const csvPath = candidatePaths.find(p => existsSync(p));
  if (!csvPath) {
    console.error('Could not find raw_leads.csv');
    process.exit(1);
  }

  console.log(`Ingesting sample data from: ${csvPath}`);
  const csvContent = readFileSync(csvPath, 'utf-8');
  const rawRows = parseCsv(csvContent);

  const payloads: RawLeadPayload[] = rawRows.map((row, idx) => ({
    lead_id: `CSV_${idx + 1}`,
    first_name: row['First Name'] || row['first_name'],
    last_name: row['Last Name'] || row['last_name'],
    phone: row['Phone Number'] || row['phone'] || row['Mobile Phone'],
    email: row['email'] || row['Email'],
    street_address: row['Address'] || row['address'],
    contact_date: row['Last Contact'] || row['contact_date'],
    lead_status: row['lead_status'] || row['Status'],
    estimated_value: row['Est. Value'] || row['estimated_value'],
    compliance_opt_out: row['Opt Out'] || row['opt_out'],
    job_type: row['job_type'],
  }));

  const pipeline = new ResilientLeadPipelineEngine();
  const result = await pipeline.processBatch(payloads, {
    enableEnrichment: true,
    enableAiTriage: true,
    enableGhlDispatch: false,
  });

  console.log('\n=============================================');
  console.log('       PIPELINE EXECUTION SUMMARY');
  console.log('=============================================');
  console.log(`Reconciliation Invariant: ${result.ledgerVerification.equation}`);
  console.log(`Ledger Balanced:          ${result.ledgerVerification.isBalanced ? 'YES (0 discrepancy)' : 'FAILED'}`);
  console.log(`Clean Master Leads:       ${result.cleanMasters.length}`);
  console.log(`Quarantined Leads:        ${result.quarantinedMasters.length}`);
  console.log(`Merged Duplicates Log:    ${result.auditLogs.length}`);
  console.log(`Enrichment Cost:          $${(result.enrichmentCostsCents / 100).toFixed(2)}`);
  console.log('=============================================\n');

  // Verify compliance override: check that Mark Smith's DNC record quarantined the whole cluster
  const markClean = result.cleanMasters.find(m => m.email?.includes('mark@smith.com'));
  const markQuarantined = result.quarantinedMasters.find(m => m.email?.includes('mark@smith.com'));

  console.log(`Compliance Check: mark@smith.com in Clean: ${!!markClean} (Expected: false)`);
  console.log(`Compliance Check: mark@smith.com in Quarantine: ${!!markQuarantined} (Expected: true)`);
}

run().catch(console.error);
