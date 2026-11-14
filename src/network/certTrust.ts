// Classifies a request failure as "the server certificate's issuer is not trusted" and builds the guidance
// appended to it (docs/spec.md §11.3). This module imports nothing, so the unit tests and the real-runtime
// contract tests (desktop, Android) can load it as it is.

export type CertTrustPlatform = 'android' | 'desktop';

// Case-sensitive substrings. Only text measured on each runtime (docs/spec.md §11.3).
export const CERT_TRUST_MARKERS: Readonly<Record<CertTrustPlatform, string>> = {
  android: 'Trust anchor for certification path not found',
  desktop: 'net::ERR_CERT_AUTHORITY_INVALID',
};

// Name of the README FAQ entry the guidance points to. README.md and README.ja.md contain it verbatim.
export const CERT_TRUST_FAQ_TITLE = 'Server certificate not trusted';

const CAUSE = 'the server\'s certificate is not trusted by Obsidian on this device, and no plugin setting can change this.';
const REMEDY_ANDROID = 'Use a publicly trusted certificate (e.g. Let\'s Encrypt) and send its full certificate chain.';
const REMEDY_DESKTOP = 'Use a publicly trusted certificate, or add your CA to the operating system\'s trust store.';

// The text of whatever a request rejected with. Never throws.
export function failureText(failure: unknown): string {
  if (failure instanceof Error) return failure.message;
  if (typeof failure === 'string') return failure;
  if (typeof failure === 'object' && failure !== null && typeof (failure as { message?: unknown }).message === 'string') {
    return (failure as { message: string }).message;
  }
  try {
    return String(failure);
  } catch {
    return '';
  }
}

export function classifyCertTrustFailure(failure: unknown): CertTrustPlatform | null {
  const text = failureText(failure);
  if (text.includes(CERT_TRUST_MARKERS.android)) return 'android';
  if (text.includes(CERT_TRUST_MARKERS.desktop)) return 'desktop';
  return null;
}

export function certTrustGuidance(platform: CertTrustPlatform): string {
  const remedy = platform === 'android' ? REMEDY_ANDROID : REMEDY_DESKTOP;
  return [CAUSE, remedy, `See "${CERT_TRUST_FAQ_TITLE}" in the README FAQ.`].join(' ');
}

// The request failure with the guidance appended after the original text. Extends Error (not NetworkError), so
// every caller handles it exactly like the plain rejection it replaces.
export class CertTrustError extends Error {
  readonly platform: CertTrustPlatform;
  readonly original: unknown;

  constructor(original: unknown, platform: CertTrustPlatform) {
    super(`${failureText(original)} — ${certTrustGuidance(platform)}`);
    this.name = 'CertTrustError';
    this.platform = platform;
    this.original = original;
  }
}

// Returns the failure itself (same reference) unless it is an untrusted-issuer failure not yet wrapped.
export function withCertTrustGuidance(failure: unknown): unknown {
  if (failure instanceof CertTrustError) return failure;
  const platform = classifyCertTrustFailure(failure);
  if (platform === null) return failure;
  return new CertTrustError(failure, platform);
}
