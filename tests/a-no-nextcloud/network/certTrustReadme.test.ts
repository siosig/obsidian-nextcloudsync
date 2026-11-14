import { readFileSync } from 'fs';
import { join } from 'path';
import { CERT_TRUST_FAQ_TITLE } from '../../../src/network/certTrust';

// The READMEs must explain the untrusted-server-certificate problem before a user hits it (docs/spec.md §11.3): the
// symptom, the cause, what works on which platform, how to fix it, and that verification cannot be switched off.
// Japanese strings are written as escapes so this file stays free of CJK.

const root = join(__dirname, '..', '..', '..');
const en = readFileSync(join(root, 'README.md'), 'utf-8');
const ja = readFileSync(join(root, 'README.ja.md'), 'utf-8');

// From the heading line to the next level-2 heading (or the end of the file).
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\n## ', start + heading.length + 2);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

// The FAQ entry about the certificate: from its bold question line to the next horizontal rule.
function faqEntry(text: string): string {
  const lines = section(text, '## FAQ').split('\n');
  const first = lines.findIndex((line) => line.startsWith('**') && line.includes(CERT_TRUST_FAQ_TITLE));
  expect(first).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(first).join('\n');
  const end = rest.indexOf('\n---\n');
  return end === -1 ? rest : rest.slice(0, end);
}

const EN_REQUIRED = [
  CERT_TRUST_FAQ_TITLE,
  // (a) the symptom, as the user sees it
  'Trust anchor for certification path not found',
  'SSLHandshakeException',
  'CertPathValidatorException',
  'net::ERR_CERT_AUTHORITY_INVALID',
  // (b) the cause
  'requestUrl',
  'cannot be fixed from the plugin settings',
  // (c) what works where
  'Android',
  'publicly trusted certificate',
  'Linux',
  'certutil',
  '~/.pki/nssdb',
  'Windows',
  'macOS',
  'iOS',
  'not verified',
  // (d) how to fix it
  'Let\'s Encrypt',
  'DNS-01',
  'full certificate chain',
  'VPN',
  'A VPN alone does not fix this',
  // (e) verification cannot be switched off
  'There is no way to turn off certificate verification',
];

const JA_REQUIRED = [
  CERT_TRUST_FAQ_TITLE,
  'Trust anchor for certification path not found',
  'SSLHandshakeException',
  'CertPathValidatorException',
  'net::ERR_CERT_AUTHORITY_INVALID',
  'requestUrl',
  '\u30d7\u30e9\u30b0\u30a4\u30f3\u306e\u8a2d\u5b9a\u3067\u306f\u76f4\u305b\u307e\u305b\u3093',
  'Android',
  '\u516c\u7684\u306b\u4fe1\u983c\u3055\u308c\u308b\u8a3c\u660e\u66f8',
  'Linux',
  'certutil',
  '~/.pki/nssdb',
  'Windows',
  'macOS',
  'iOS',
  '\u672a\u78ba\u8a8d',
  'Let\'s Encrypt',
  'DNS-01',
  '\u4e2d\u9593\u8a3c\u660e\u66f8',
  'VPN',
  'VPN \u3060\u3051\u3067\u306f\u89e3\u6c7a\u3057\u307e\u305b\u3093',
  '\u8a3c\u660e\u66f8\u306e\u691c\u8a3c\u3092\u7121\u52b9\u306b\u3059\u308b\u65b9\u6cd5\u306f\u3042\u308a\u307e\u305b\u3093',
];

const EN_QUESTION =
  '**Server certificate not trusted (`Trust anchor for certification path not found` / `net::ERR_CERT_AUTHORITY_INVALID`) — can I use a self-signed or private-CA certificate?**';
const JA_QUESTION =
  '**\u30b5\u30fc\u30d0\u30fc\u8a3c\u660e\u66f8\u304c\u4fe1\u983c\u3055\u308c\u306a\u3044\uff08Server certificate not trusted\uff09: `Trust anchor for certification path not found` \u3084 `net::ERR_CERT_AUTHORITY_INVALID` \u304c\u51fa\u307e\u3059\u3002\u81ea\u5df1\u7f72\u540d\u3084\u79c1\u7684 CA \u306e\u8a3c\u660e\u66f8\u306f\u4f7f\u3048\u307e\u3059\u304b\uff1f**';

describe('[SPEC:CTE-6] the READMEs explain the untrusted server certificate', () => {
  it.each(EN_REQUIRED)('README.md FAQ entry contains: %s', (needle) => {
    expect(faqEntry(en)).toContain(needle);
  });

  it.each(JA_REQUIRED)('README.ja.md FAQ entry contains: %s', (needle) => {
    expect(faqEntry(ja)).toContain(needle);
  });

  it('README.md states the question in the fixed wording', () => {
    expect(faqEntry(en)).toContain(EN_QUESTION);
  });

  it('README.ja.md states the question in the fixed wording', () => {
    expect(faqEntry(ja)).toContain(JA_QUESTION);
  });

  it('README.md Requirements points to the FAQ entry', () => {
    expect(section(en, '## Requirements')).toContain(CERT_TRUST_FAQ_TITLE);
  });

  it('README.ja.md Requirements points to the FAQ entry', () => {
    // "## Requirements" in Japanese: the heading of the requirements section.
    expect(section(ja, '## \u52d5\u4f5c\u8981\u4ef6')).toContain(CERT_TRUST_FAQ_TITLE);
  });
});
