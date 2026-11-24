import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Validates HMAC SHA-256 webhook signature.
 * Prevents unauthorized or spoofed webhooks from entering the ingestion pipeline.
 */
export function verifyWebhookSignature(
  rawPayload: string | Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  // Remove potential sha256= prefix if present
  const cleanSignature = signatureHeader.replace(/^sha256=/i, '').trim();

  try {
    const hmac = createHmac('sha256', secret);
    hmac.update(rawPayload);
    const expectedSignature = hmac.digest('hex');

    const signatureBuffer = Buffer.from(cleanSignature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (signatureBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
