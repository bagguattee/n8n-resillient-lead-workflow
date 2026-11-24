import type { JobTypeCategory, LeadStatus } from '../types/index.ts';

// Common disposable/burner email domains
export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  '10minutemail.com',
  'tempmail.com',
  'yopmail.com',
  'sharklasers.com',
  'guerrillamail.com',
  'dispostable.com',
  'throwawaymail.com',
]);

// Common consumer email domain typos
export const DOMAIN_TYPO_MAP: Record<string, string> = {
  'gamil.com': 'gmail.com',
  'gmial.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'yaho.com': 'yahoo.com',
  'yahoocom': 'yahoo.com',
  'aol.co': 'aol.com',
  'hotmai.com': 'hotmail.com',
  'hotmial.com': 'hotmail.com',
  'outlok.com': 'outlook.com',
};

// Strict bad placeholders that should NEVER be accepted as valid names, emails, or data
export const JUNK_PLACEHOLDERS = new Set([
  'idk',
  'n/a',
  'na',
  'none',
  'null',
  'nan',
  'unknown',
  'dummy',
  'test',
  'testing',
  'asdf',
  'aaaa',
  'user',
  'noemail',
  'fake',
  'placeholder',
  '0000000000',
  '1234567890',
]);

export function isPlaceholder(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  const s = String(val).trim().toLowerCase();
  return s === '' || JUNK_PLACEHOLDERS.has(s);
}

export function sanitizeText(val: unknown): string | null {
  if (isPlaceholder(val)) return null;
  const s = String(val)
    .normalize('NFKD')
    .replace(/[^\w\s\-'.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 0 ? s : null;
}

export function toTitleCase(val: unknown): string {
  const sanitized = sanitizeText(val);
  if (!sanitized) return '';
  return sanitized
    .split(' ')
    .map(word => {
      if (word.length === 0) return '';
      // Support hyphenated names like Smith-Jones
      if (word.includes('-')) {
        return word.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join('-');
      }
      // Support apostrophe names like O'Connor or D'Angelo
      if (word.includes("'")) {
        return word.split("'").map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join("'");
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

export function normalizePhone(rawPhone: unknown, country = 'US'): string | null {
  if (isPlaceholder(rawPhone)) return null;

  let s = String(rawPhone).trim();
  // Strip trailing Excel floats (e.g. 5551234567.0)
  s = s.replace(/\.0+$/, '');
  // Extract primary phone number before extensions or delimiters
  s = s.split(/\s*(?:ext|x|\/|or|aest|am|pm|,)/i)[0] || '';
  // Keep only digits
  const digits = s.replace(/\D/g, '');

  if (country === 'US') {
    if (digits.length === 11 && digits.startsWith('1')) {
      return `+${digits}`;
    }
    if (digits.length === 10) {
      // 10-digit local number -> E.164 (+1XXXXXXXXXX)
      return `+1${digits}`;
    }
    return null; // Corrupted / non-compliant phone
  }

  return digits.length >= 8 ? `+${digits}` : null;
}

export function normalizeEmail(rawEmail: unknown): { primary: string | null; secondary: string | null; isDisposable: boolean } {
  if (isPlaceholder(rawEmail)) {
    return { primary: null, secondary: null, isDisposable: false };
  }

  const rawStr = String(rawEmail).trim();
  // Support comma / semicolon separated multiple emails
  const candidates = rawStr
    .split(/[;,]/)
    .map(e => e.trim())
    .filter(e => e.length > 0);

  if (candidates.length === 0) {
    return { primary: null, secondary: null, isDisposable: false };
  }

  const cleanCandidate = (cand: string) => {
    let email = cand.toLowerCase().replace(/[^\x20-\x7E]/g, '').trim().replace(/^\.+|\.+$/g, '');
    if (!email.includes('@') || email.length < 5) return null;

    const [local, rawDomain] = email.split('@');
    if (!local || !rawDomain) return null;

    if (isPlaceholder(local) || local.startsWith('noemail') || local.startsWith('fake')) {
      return null;
    }

    let domain = rawDomain.trim();
    if (DOMAIN_TYPO_MAP[domain]) {
      domain = DOMAIN_TYPO_MAP[domain];
    }

    if (DISPOSABLE_DOMAINS.has(domain)) {
      return { email: `${local}@${domain}`, isDisposable: true };
    }

    // RFC-compliant validation
    const emailRegex = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
    const finalEmail = `${local}@${domain}`;
    if (!emailRegex.test(finalEmail)) {
      return null;
    }

    return { email: finalEmail, isDisposable: false };
  };

  const primaryResult = cleanCandidate(candidates[0]!);
  let secondaryResult = candidates.length > 1 ? cleanCandidate(candidates[1]!) : null;

  return {
    primary: primaryResult ? primaryResult.email : null,
    secondary: secondaryResult ? secondaryResult.email : null,
    isDisposable: !!primaryResult?.isDisposable || !!secondaryResult?.isDisposable,
  };
}

export function normalizeJobType(raw: unknown): JobTypeCategory {
  if (isPlaceholder(raw)) return 'GENERAL_ENQUIRY';
  const s = String(raw).toLowerCase();

  if (s.includes('replace') || s.includes('reroof') || s.includes('installation') || s.includes('new roof')) {
    return 'REPLACEMENT';
  }
  if (s.includes('repair') || s.includes('leak') || s.includes('patch') || s.includes('shingle')) {
    return 'REPAIR';
  }
  if (s.includes('inspect') || s.includes('assessment') || s.includes('estimate') || s.includes('audit')) {
    return 'INSPECTION';
  }
  if (s.includes('maintenance') || s.includes('clean') || s.includes('gutter')) {
    return 'MAINTENANCE';
  }
  return 'GENERAL_ENQUIRY';
}

export function normalizeLeadStatus(raw: unknown): LeadStatus {
  if (isPlaceholder(raw)) return 'NEW';
  const s = String(raw).toLowerCase().replace(/[^a-z]/g, '');

  if (s.includes('won') || s.includes('closedwon') || s.includes('sold')) return 'WON';
  if (s.includes('lost') || s.includes('closedlost')) return 'LOST';
  if (s.includes('dead') || s.includes('unqualified')) return 'DEAD';
  if (s.includes('active') || s.includes('spoketoowner') || s.includes('contacted')) return 'ACTIVE';
  if (s.includes('quote') || s.includes('estimate')) return 'QUOTE_SENT';
  if (s.includes('inspection') || s.includes('scheduled')) return 'INSPECTION_COMPLETED';
  return 'NEW';
}

export function normalizeEstimatedValue(raw: unknown): number {
  if (isPlaceholder(raw)) return 0;
  const s = String(raw).replace(/[^0-9.]/g, '');
  const parsed = parseFloat(s);
  return isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

export function parseContactDate(raw: unknown): Date {
  if (isPlaceholder(raw)) return new Date();
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? new Date() : d;
}
