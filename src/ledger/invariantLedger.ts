import type { LedgerCounts, LedgerVerification } from '../types/index.ts';

export class InvariantLedger {
  private counts: LedgerCounts = {
    ingested: 0,
    processed: 0,
    duplicates: 0,
    quarantined: 0,
    failed: 0,
  };

  private events: Array<{
    timestamp: Date;
    leadId: string;
    action: 'INGEST' | 'PROCESS' | 'DUPLICATE' | 'QUARANTINE' | 'FAIL';
    reason?: string;
  }> = [];

  public recordIngest(leadId: string): void {
    this.counts.ingested++;
    this.events.push({ timestamp: new Date(), leadId, action: 'INGEST' });
  }

  public recordProcessed(leadId: string): void {
    this.counts.processed++;
    this.events.push({ timestamp: new Date(), leadId, action: 'PROCESS' });
  }

  public recordDuplicate(leadId: string, mergedIntoId: string, reason: string): void {
    this.counts.duplicates++;
    this.events.push({
      timestamp: new Date(),
      leadId,
      action: 'DUPLICATE',
      reason: `Merged into ${mergedIntoId}: ${reason}`,
    });
  }

  public recordQuarantined(leadId: string, reason: string): void {
    this.counts.quarantined++;
    this.events.push({ timestamp: new Date(), leadId, action: 'QUARANTINE', reason });
  }

  public recordFailed(leadId: string, reason: string): void {
    this.counts.failed++;
    this.events.push({ timestamp: new Date(), leadId, action: 'FAIL', reason });
  }

  /**
   * Enforces the Reconciliation Invariant Equation:
   * Ingested = Processed + Duplicates + Quarantined + Failed
   */
  public verify(): LedgerVerification {
    const totalAccountedFor =
      this.counts.processed +
      this.counts.duplicates +
      this.counts.quarantined +
      this.counts.failed;

    const discrepancy = this.counts.ingested - totalAccountedFor;
    const isBalanced = discrepancy === 0;

    const equation = `${this.counts.ingested} (Ingested) = ${this.counts.processed} (Processed) + ${this.counts.duplicates} (Duplicates) + ${this.counts.quarantined} (Quarantined) + ${this.counts.failed} (Failed)`;

    return {
      isBalanced,
      equation,
      discrepancy,
      ledger: { ...this.counts },
    };
  }

  public getCounts(): LedgerCounts {
    return { ...this.counts };
  }

  public getEvents() {
    return [...this.events];
  }

  public reset(): void {
    this.counts = {
      ingested: 0,
      processed: 0,
      duplicates: 0,
      quarantined: 0,
      failed: 0,
    };
    this.events = [];
  }
}
