import {
  hrefToRelative,
  fromRemotePath,
  toRemotePath,
  isSafeVaultRelativePath,
  encodeRemoteUrl,
  encodeServerUrl,
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


// [SPEC:URE-1] [SPEC:URE-3] [SPEC:URE-4]: feature 065 (issue #25). ONE encoding scheme for every
// platform — encodeRemoteUrl takes no platform argument at all, which is what makes "iOS behaves
// differently here" unrepresentable rather than merely discouraged. Feature 061's iOS branch (leave
// the path raw and let the request layer encode it) is gone: a raw space is NOT encoded there, so
// every path containing one 404'd. The scheme below is byte-for-byte webdav-client's encodePath(),
// which remotely-save ships to iOS users at scale.
describe('encodeRemoteUrl', () => {
  const baseUrl = 'https://example.com/remote.php/dav/files/alice';

  it('percent-encodes an ASCII space (the issue #25 regression)', () => {
    expect(encodeRemoteUrl(baseUrl, 'Directory Name/FileName.md'))
      .toBe(`${baseUrl}/Directory%20Name/FileName.md`);
    expect(encodeRemoteUrl(baseUrl, 'This Is A Note.md'))
      .toBe(`${baseUrl}/This%20Is%20A%20Note.md`);
  });

  it('percent-encodes CJK characters as UTF-8', () => {
    expect(encodeRemoteUrl(baseUrl, '中文目录/日记.md'))
      .toBe(`${baseUrl}/%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95/%E6%97%A5%E8%AE%B0.md`);
  });

  it('percent-encodes a mixed space + CJK path (the PR #17 folder name)', () => {
    expect(encodeRemoteUrl(baseUrl, '00 收件箱/未命名.md'))
      .toBe(`${baseUrl}/00%20%E6%94%B6%E4%BB%B6%E7%AE%B1/%E6%9C%AA%E5%91%BD%E5%90%8D.md`);
  });

  it('percent-encodes URL-structural ASCII characters (#, ?, %)', () => {
    expect(encodeRemoteUrl(baseUrl, 'a#b?c%d.md'))
      .toBe(`${baseUrl}/a%23b%3Fc%25d.md`);
  });

  // The reporter of issue #25 noted `&` synced fine while spaces did not — `&` is legal raw in a
  // path, a space is not. Encoding it anyway is correct and costs nothing.
  it('percent-encodes & as well', () => {
    expect(encodeRemoteUrl(baseUrl, 'Test&Note.md')).toBe(`${baseUrl}/Test%26Note.md`);
  });

  it('keeps an emoji (surrogate pair) intact as 4-byte UTF-8', () => {
    expect(encodeRemoteUrl(baseUrl, '📁folder/note.md'))
      .toBe(`${baseUrl}/%F0%9F%93%81folder/note.md`);
  });

  it('treats "/" as the path separator, never encoding it to %2F', () => {
    const url = encodeRemoteUrl(baseUrl, 'a/b/c.md');
    expect(url).toBe(`${baseUrl}/a/b/c.md`);
    expect(url).not.toContain('%2F');
  });

  it('preserves empty segments (consecutive slashes) rather than collapsing them', () => {
    expect(encodeRemoteUrl(baseUrl, 'a//b.md')).toBe(`${baseUrl}/a//b.md`);
  });

  it('returns baseUrl unchanged for an empty path', () => {
    expect(encodeRemoteUrl(baseUrl, '')).toBe(baseUrl);
  });

  // Guards the actual defect shape: encoding twice yields %25.. and the server stores the literal
  // percent sequence as the name. One pass, and only one, may ever be applied here.
  it('encodes exactly once — no %25 appears for input that contains no literal %', () => {
    expect(encodeRemoteUrl(baseUrl, '00 收件箱/未命名.md')).not.toContain('%25');
  });

  // [SPEC:URE-3] send/receive symmetry: whatever we encode, hrefToRelative must decode back.
  describe('round-trips through hrefToRelative', () => {
    const base = 'MyVault';
    const paths = [
      'Directory Name/FileName.md',
      'This Is A Note.md',
      '00 收件箱/未命名.md',
      'Test&Note.md',
      'a#b?c%d.md',
      '📁folder/note.md',
      'plain.md',
    ];
    it.each(paths)('%s', (rel) => {
      const url = encodeRemoteUrl(baseUrl, toRemotePath(base, rel));
      expect(hrefToRelative(baseUrl, base, url)).toBe(rel);
    });
  });
});

// [SPEC:URE-4]: the Server URL may end in a subfolder holding a space or non-ASCII characters, and
// it is the base of every request URL — so it needs the same one-pass treatment. A value that
// already contains `%` was pasted pre-encoded (browsers show URLs that way) and must be left alone,
// otherwise `%20` would become `%2520` — the exact corruption this feature exists to prevent.
describe('encodeServerUrl', () => {
  it('encodes a space in a raw Server URL', () => {
    expect(encodeServerUrl('https://example.com/dav/My Folder'))
      .toBe('https://example.com/dav/My%20Folder');
  });

  it('encodes non-ASCII in a raw Server URL', () => {
    expect(encodeServerUrl('https://example.com/dav/フォルダ'))
      .toBe('https://example.com/dav/%E3%83%95%E3%82%A9%E3%83%AB%E3%83%80');
  });

  it('leaves an already-encoded Server URL untouched (no %2520)', () => {
    const encoded = 'https://example.com/dav/My%20Folder';
    expect(encodeServerUrl(encoded)).toBe(encoded);
    expect(encodeServerUrl(encoded)).not.toContain('%2520');
  });

  it('leaves a plain ASCII Server URL unchanged', () => {
    const plain = 'https://example.com/remote.php/dav/files/alice';
    expect(encodeServerUrl(plain)).toBe(plain);
  });

  it('keeps scheme, host, port and path separators intact', () => {
    expect(encodeServerUrl('https://example.com:8443/a b/c'))
      .toBe('https://example.com:8443/a%20b/c');
  });

  it('returns an empty string unchanged', () => {
    expect(encodeServerUrl('')).toBe('');
  });
});
