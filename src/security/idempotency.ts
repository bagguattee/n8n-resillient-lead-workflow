import { createHash } from 'node:crypto';

export interface IdempotencyRecord {
  key: string;
  payloadHash: string;
  firstSeenAt: Date;
  status: 'PROCESSED' | 'IN_FLIGHT' | 'FAILED';
  responseSummary?: Record<string, unknown>;
}

export class IdempotencyGuard {
  private cache = new Map<string, IdempotencyRecord>();
  private readonly windowMs: number;

  constructor(windowMs: number = 24 * 60 * 60 * 1000) {
    this.windowMs = windowMs;
  }

  /**
   * Generates a stable deterministic SHA-256 hash of any JSON payload.
   */
  public computePayloadHash(payload: unknown): string {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload, Object.keys(payload as object).sort());
    return createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Checks if the payload or key has already been seen within the active idempotency window.
   */
  public checkIdempotency(keyOrPayload: string | unknown): { isDuplicate: boolean; existing?: IdempotencyRecord } {
    const key = typeof keyOrPayload === 'string' ? keyOrPayload : this.computePayloadHash(keyOrPayload);
    const now = Date.now();

    const existing = this.cache.get(key);
    if (existing) {
      if (now - existing.firstSeenAt.getTime() < this.windowMs) {
        return { isDuplicate: true, existing };
      }
      // Expired record
      this.cache.delete(key);
    }

    return { isDuplicate: false };
  }

  /**
   * Registers a key as seen and in-flight/processed.
   */
  public register(key: string, payloadHash: string, status: 'PROCESSED' | 'IN_FLIGHT' = 'PROCESSED'): IdempotencyRecord {
    const record: IdempotencyRecord = {
      key,
      payloadHash,
      firstSeenAt: new Date(),
      status,
    };
    this.cache.set(key, record);
    return record;
  }

  public getCacheSize(): number {
    return this.cache.size;
  }

  public clear(): void {
    this.cache.clear();
  }
}
