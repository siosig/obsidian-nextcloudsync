import {
  hrefToRelative,
  fromRemotePath,
  toRemotePath,
  isSafeVaultRelativePath,
  encodeRemoteUrl,
} from '../../../src/network/remotePath';

describe('hrefToRelative', () => {
  // Regression: Server URL pointing at a subfolder under the WebDAV files root.
  // Previously the href was only stripped up to `/remote.php/dav/files/<user>/`,
  // leaving the `Documents/obsidian/` prefix, so fromRemotePath() returned null and
  // every remote file was filtered out → the initial sync marked everything as upload.
  const baseUrl = 'https://example.com/nextcloud/remote.php/dav/files/alice/Documents/obsidian';
  const vault = 'Obsidian Vault';

  it('maps an href under a sub-path Server URL to a Vault-relative path', () => {
    const href = '/nextcloud/remote.php/dav/files/alice/Documents/obsidian/Obsidian%20Vault/notes/a.md';
    expect(hrefToRelative(baseUrl, vault, href)).toBe('notes/a.md');
  });

  it('decodes percent-encoded (multibyte) segments', () => {
    const href = '/nextcloud/remote.php/dav/files/alice/Documents/obsidian/Obsidian%20Vault/%E3%83%A1%E3%83%A2/x.md';
    expect(hrefToRelative(baseUrl, vault, href)).toBe('メモ/x.md');
  });

  it('returns "" for the base folder itself', () => {
    const href = '/nextcloud/remote.php/dav/files/alice/Documents/obsidian/Obsidian%20Vault/';
    expect(hrefToRelative(baseUrl, vault, href)).toBe('');
  });

  it('returns null for entries outside the base folder', () => {
    const href = '/nextcloud/remote.php/dav/files/alice/Documents/obsidian/Other%20Vault/a.md';
    expect(hrefToRelative(baseUrl, vault, href)).toBeNull();
  });

  it('accepts an absolute-URL href as well as an absolute-path href', () => {
    const href = 'https://example.com/nextcloud/remote.php/dav/files/alice/Documents/obsidian/Obsidian%20Vault/b.md';
    expect(hrefToRelative(baseUrl, vault, href)).toBe('b.md');
  });

  it('works when the Server URL is exactly the files root (no extra sub-path)', () => {
    const rootBase = 'https://host/remote.php/dav/files/alice';
    const href = '/remote.php/dav/files/alice/Obsidian%20Vault/c.md';
    expect(hrefToRelative(rootBase, vault, href)).toBe('c.md');
  });

  it('round-trips with toRemotePath/fromRemotePath for the relative form', () => {
    const rel = 'notes/a.md';
    expect(fromRemotePath(vault, toRemotePath(vault, rel))).toBe(rel);
  });

  // Security: a malicious/compromised server must not be able to craft an href that
  // escapes the Vault root and reaches a local file sink (write/delete/rename).
  it('rejects path-traversal hrefs (returns null, treated as out of scope)', () => {
    const href = '/nextcloud/remote.php/dav/files/alice/Documents/obsidian/Obsidian%20Vault/../../../etc/passwd';
    expect(hrefToRelative(baseUrl, vault, href)).toBeNull();
  });
});

describe('isSafeVaultRelativePath', () => {
  it.each([
    ['notes/a.md', true],
    ['', true],
    ['.obsidian/snippets/x.css', true],
    ['../escape.md', false],
    ['notes/../../etc/passwd', false],
    ['/abs/path.md', false],
    ['C:/Windows/system32', false],
    ['notes\\a.md', false],
  ])('%s → %s', (rel, expected) => {
    expect(isSafeVaultRelativePath(rel as string)).toBe(expected);
  });
});

describe('fromRemotePath (traversal hardening)', () => {
  it('returns null when the stripped path contains a .. segment', () => {
    expect(fromRemotePath('Vault', 'Vault/../../secret.md')).toBeNull();
  });
  it('returns null for traversal when no base is configured', () => {
    expect(fromRemotePath('', '../secret.md')).toBeNull();
  });
});

describe('encodeRemoteUrl', () => {
  const baseUrl = 'https://example.com/remote.php/dav/files/alice';

  it('leaves Chinese path characters for the Obsidian request layer to encode once', () => {
    expect(encodeRemoteUrl(baseUrl, '中文仓库/日记.md'))
      .toBe(`${baseUrl}/中文仓库/日记.md`);
  });

  it('preserves Unicode while escaping ASCII URL delimiters inside file names', () => {
    expect(encodeRemoteUrl(baseUrl, '资料 目录/问题#1?.md'))
      .toBe(`${baseUrl}/资料%20目录/问题%231%3F.md`);
  });

  it('keeps path separators instead of escaping them', () => {
    expect(encodeRemoteUrl(baseUrl, 'a/b/c.md')).toBe(`${baseUrl}/a/b/c.md`);
  });
});
