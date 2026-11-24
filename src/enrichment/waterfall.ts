import type { EnrichmentData, EnrichmentResult } from '../types/index.ts';

export interface EnrichmentProvider {
  name: 'LOCAL_CACHE' | 'PRIMARY_API' | 'FALLBACK_API';
  costCents: number;
  lookup(addressOrPhone: string): Promise<EnrichmentData | null>;
}

export interface AccountingLog {
  timestamp: Date;
  addressOrPhone: string;
  provider: 'LOCAL_CACHE' | 'PRIMARY_API' | 'FALLBACK_API';
  costCents: number;
  durationMs: number;
  success: boolean;
}

export class LocalCacheEnrichmentProvider implements EnrichmentProvider {
  public readonly name = 'LOCAL_CACHE';
  public readonly costCents = 0.0;
  private cache = new Map<string, EnrichmentData>();

  constructor(initialData?: Record<string, EnrichmentData>) {
    if (initialData) {
      for (const [k, v] of Object.entries(initialData)) {
        this.cache.set(k.toLowerCase().trim(), v);
      }
    }
  }

  public set(key: string, data: EnrichmentData): void {
    this.cache.set(key.toLowerCase().trim(), data);
  }

  public async lookup(addressOrPhone: string): Promise<EnrichmentData | null> {
    const key = addressOrPhone.toLowerCase().trim();
    return this.cache.get(key) || null;
  }
}

export class PrimaryMockEnrichmentProvider implements EnrichmentProvider {
  public readonly name = 'PRIMARY_API';
  public readonly costCents = 5.0; // 5 cents ($0.05)
  private readonly failureKeys: Set<string>;

  constructor(failureKeys: string[] = []) {
    this.failureKeys = new Set(failureKeys.map(k => k.toLowerCase().trim()));
  }

  public async lookup(addressOrPhone: string): Promise<EnrichmentData | null> {
    const key = addressOrPhone.toLowerCase().trim();
    if (this.failureKeys.has(key)) {
      return null; // Simulates provider not having this address
    }

    // Deterministic mock generation based on string hash
    const hash = key.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return {
      property_type: hash % 2 === 0 ? 'SINGLE_FAMILY' : 'MULTI_FAMILY',
      roof_square_footage: 2200 + (hash % 15) * 100,
      year_built: 1985 + (hash % 38),
      estimated_home_value: 350000 + (hash % 50) * 10000,
      homeowner_confirmed: true,
      credit_tier: hash % 3 === 0 ? 'PRIME' : 'NEAR_PRIME',
    };
  }
}

export class FallbackMockEnrichmentProvider implements EnrichmentProvider {
  public readonly name = 'FALLBACK_API';
  public readonly costCents = 12.0; // 12 cents ($0.12)

  public async lookup(addressOrPhone: string): Promise<EnrichmentData | null> {
    const key = addressOrPhone.toLowerCase().trim();
    const hash = key.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return {
      property_type: 'RESIDENTIAL',
      roof_square_footage: 2000 + (hash % 10) * 120,
      year_built: 1990 + (hash % 30),
      estimated_home_value: 320000 + (hash % 40) * 8000,
      homeowner_confirmed: false,
      credit_tier: 'STANDARD',
    };
  }
}

export class WaterfallEnrichmentEngine {
  private localCache: LocalCacheEnrichmentProvider;
  private primaryApi: PrimaryMockEnrichmentProvider;
  private fallbackApi: FallbackMockEnrichmentProvider;
  private accountingLedger: AccountingLog[] = [];

  constructor(
    localCache = new LocalCacheEnrichmentProvider(),
    primaryApi = new PrimaryMockEnrichmentProvider(),
    fallbackApi = new FallbackMockEnrichmentProvider()
  ) {
    this.localCache = localCache;
    this.primaryApi = primaryApi;
    this.fallbackApi = fallbackApi;
  }

  public async enrich(addressOrPhone: string): Promise<EnrichmentResult> {
    const start = performance.now();
    const key = addressOrPhone.trim();

    // Step 1: Local Cache Check ($0.00 cost)
    const cachedData = await this.localCache.lookup(key);
    if (cachedData) {
      const durationMs = Math.round(performance.now() - start);
      this.logAccounting(key, 'LOCAL_CACHE', 0, durationMs, true);
      return {
        provider: 'LOCAL_CACHE',
        cost_cents: 0,
        duration_ms: durationMs,
        data: cachedData,
        cached: true,
      };
    }

    // Step 2: Primary Mock Provider ($0.05 cost)
    const primaryStart = performance.now();
    const primaryData = await this.primaryApi.lookup(key);
    if (primaryData) {
      const durationMs = Math.round(performance.now() - primaryStart);
      this.logAccounting(key, 'PRIMARY_API', this.primaryApi.costCents, durationMs, true);
      // Write back to local cache
      this.localCache.set(key, primaryData);
      return {
        provider: 'PRIMARY_API',
        cost_cents: this.primaryApi.costCents,
        duration_ms: Math.round(performance.now() - start),
        data: primaryData,
        cached: false,
      };
    }
    this.logAccounting(key, 'PRIMARY_API', this.primaryApi.costCents, Math.round(performance.now() - primaryStart), false);

    // Step 3: Fallback Mock Provider ($0.12 cost)
    const fallbackStart = performance.now();
    const fallbackData = await this.fallbackApi.lookup(key);
    const durationMs = Math.round(performance.now() - fallbackStart);
    this.logAccounting(key, 'FALLBACK_API', this.fallbackApi.costCents, durationMs, !!fallbackData);

    const resultData = fallbackData || {};
    this.localCache.set(key, resultData);

    return {
      provider: 'FALLBACK_API',
      cost_cents: this.fallbackApi.costCents + this.primaryApi.costCents,
      duration_ms: Math.round(performance.now() - start),
      data: resultData,
      cached: false,
    };
  }

  private logAccounting(
    addressOrPhone: string,
    provider: 'LOCAL_CACHE' | 'PRIMARY_API' | 'FALLBACK_API',
    costCents: number,
    durationMs: number,
    success: boolean
  ): void {
    this.accountingLedger.push({
      timestamp: new Date(),
      addressOrPhone,
      provider,
      costCents,
      durationMs,
      success,
    });
  }

  public getAccountingLedger(): AccountingLog[] {
    return [...this.accountingLedger];
  }

  public getTotalCostCents(): number {
    return this.accountingLedger.reduce((sum, item) => sum + item.costCents, 0);
  }
}
