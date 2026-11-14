import {
  CERT_TRUST_FAQ_TITLE,
  CERT_TRUST_MARKERS,
  CertTrustError,
  certTrustGuidance,
  classifyCertTrustFailure,
  failureText,
  withCertTrustGuidance,
} from '../../../src/network/certTrust';
import { NetworkError } from '../../../src/types';

// The classification of an untrusted-server-certificate failure and the guidance text appended to it
// (docs/spec.md §11.3). Only text measured on each runtime counts; everything else must pass through unchanged.

const ANDROID_FULL =
  'Request Failed. SSLHandshakeException java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.';
const DESKTOP_TEXT = 'net::ERR_CERT_AUTHORITY_INVALID';

const ANDROID_GUIDANCE =
  'the server\'s certificate is not trusted by Obsidian on this device, and no plugin setting can change this. ' +
  'Use a publicly trusted certificate (e.g. Let\'s Encrypt) and send its full certificate chain. ' +
  'See "Server certificate not trusted" in the README FAQ.';
const DESKTOP_GUIDANCE =
  'the server\'s certificate is not trusted by Obsidian on this device, and no plugin setting can change this. ' +
  'Use a publicly trusted certificate, or add your CA to the operating system\'s trust store. ' +
  'See "Server certificate not trusted" in the README FAQ.';

describe('[SPEC:CTE-1] certificate-trust classification', () => {
  it.each<[string, unknown]>([
    ['an Error', new Error(ANDROID_FULL)],
    ['a string', ANDROID_FULL],
    ['an object with a string message', { message: ANDROID_FULL }],
  ])('classifies the Android text carried by %s as android', (_label, failure) => {
    expect(classifyCertTrustFailure(failure)).toBe('android');
  });

  it.each<[string, unknown]>([
    ['an Error', new Error(DESKTOP_TEXT)],
    ['a string', DESKTOP_TEXT],
  ])('classifies the desktop text carried by %s as desktop', (_label, failure) => {
    expect(classifyCertTrustFailure(failure)).toBe('desktop');
  });

  it('checks Android first when both markers are present', () => {
    expect(classifyCertTrustFailure(new Error(`${DESKTOP_TEXT} ${ANDROID_FULL}`))).toBe('android');
  });

  it('keeps the two measured markers as the only classification texts', () => {
    expect(CERT_TRUST_MARKERS).toEqual({
      android: 'Trust anchor for certification path not found',
      desktop: 'net::ERR_CERT_AUTHORITY_INVALID',
    });
  });

  describe('failureText', () => {
    it.each<[string, unknown, string]>([
      ['an Error', new Error('m'), 'm'],
      ['a string', 's', 's'],
      ['an object with a string message', { message: 'x' }, 'x'],
      ['an object with a non-string message', { message: 1 }, '[object Object]'],
      ['undefined', undefined, 'undefined'],
      ['null', null, 'null'],
      ['a number', 42, '42'],
      [
        'a value whose string conversion throws',
        {
          [Symbol.toPrimitive]() {
            throw new Error('no conversion');
          },
        },
        '',
      ],
    ])('turns %s into text', (_label, failure, expected) => {
      expect(failureText(failure)).toBe(expected);
    });
  });
});

describe('[SPEC:CTE-2] certificate-trust guidance', () => {
  it('returns the exact Android text', () => {
    expect(certTrustGuidance('android')).toBe(ANDROID_GUIDANCE);
  });

  it('returns the exact desktop text', () => {
    expect(certTrustGuidance('desktop')).toBe(DESKTOP_GUIDANCE);
  });

  it.each<['android' | 'desktop']>([['android'], ['desktop']])(
    'keeps the %s guidance short, platform-neutral and pointing to the FAQ entry',
    (platform) => {
      const text = certTrustGuidance(platform);
      expect(text.length).toBeLessThanOrEqual(260);
      expect(text).not.toMatch(/\b(Android|iOS|Windows|macOS|Linux)\b/);
      expect(text).toContain(`"${CERT_TRUST_FAQ_TITLE}"`);
      expect(text).toMatch(/^[a-z]/);
    },
  );

  it('names the FAQ entry exactly as the README does', () => {
    expect(CERT_TRUST_FAQ_TITLE).toBe('Server certificate not trusted');
  });

  it('builds the error message as "<original> — <guidance>" and keeps the original reference', () => {
    const original = new Error(DESKTOP_TEXT);
    const wrapped = new CertTrustError(original, 'desktop');
    expect(wrapped.name).toBe('CertTrustError');
    expect(wrapped.message).toBe(`${original.message} — ${certTrustGuidance('desktop')}`);
    expect(wrapped.platform).toBe('desktop');
    expect(wrapped.original).toBe(original);
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped).toBeInstanceOf(CertTrustError);
  });

  it('is idempotent: wrapping an already wrapped failure returns the same reference and one guidance', () => {
    const once = withCertTrustGuidance(new Error(DESKTOP_TEXT));
    expect(once).toBeInstanceOf(CertTrustError);
    expect(withCertTrustGuidance(once)).toBe(once);
    expect((once as Error).message.split(CERT_TRUST_FAQ_TITLE)).toHaveLength(2);
  });

  it('wraps a failure that is a plain string and keeps it at the start of the message', () => {
    const wrapped = withCertTrustGuidance(ANDROID_FULL);
    expect(wrapped).toBeInstanceOf(CertTrustError);
    expect((wrapped as Error).message.startsWith(ANDROID_FULL)).toBe(true);
    expect((wrapped as CertTrustError).platform).toBe('android');
  });
});

describe('[SPEC:CTE-4] failures that are not an untrusted issuer get no guidance', () => {
  const OTHER_TEXTS = [
    'Network request timed out after 30s: GET https://x/',
    'net::ERR_CERT_DATE_INVALID',
    'net::ERR_CERT_COMMON_NAME_INVALID',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_SSL_CLIENT_AUTH_CERT_NEEDED',
    'SSLHandshakeException',
    'java.security.cert.CertPathValidatorException: timestamp check failed',
    'Hostname nc.test not verified',
    'trust anchor for certification path not found',
  ];

  const failures: Array<[string, unknown]> = OTHER_TEXTS.flatMap((text): Array<[string, unknown]> => [
    [`an Error: ${text}`, new Error(text)],
    [`a string: ${text}`, text],
  ]);
  failures.push(['a NetworkError (HTTP 404)', new NetworkError(404, '', 'PROPFIND')]);

  it.each(failures)('leaves %s alone', (_label, failure) => {
    expect(classifyCertTrustFailure(failure)).toBeNull();
    expect(withCertTrustGuidance(failure)).toBe(failure);
  });
});
