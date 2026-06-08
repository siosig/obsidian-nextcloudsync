import { hrefToRelative, fromRemotePath, toRemotePath } from '../../src/network/remotePath';

describe('hrefToRelative', () => {
  // Regression: Server URL pointing at a subfolder under the WebDAV files root.
  // Previously the href was only stripped up to `/remote.php/dav/files/<user>/`,
  // leaving the `Documents/obsidian/` prefix, so fromRemotePath() returned null and
  // every remote file was filtered out → the initial sync marked everything as upload.
  const baseUrl = 'https://example.com/nextcloud/remote.php/dav/files/siosig/Documents/obsidian';
  const vault = 'Obsidian Vault';

  it('maps an href under a sub-path Server URL to a Vault-relative path', () => {
    const href = '/nextcloud/remote.php/dav/files/siosig/Documents/obsidian/Obsidian%20Vault/01_daily/a.md';
    expect(hrefToRelative(baseUrl, vault, href)).toBe('01_daily/a.md');
  });

  it('decodes percent-encoded (multibyte) segments', () => {
    const href = '/nextcloud/remote.php/dav/files/siosig/Documents/obsidian/Obsidian%20Vault/05_%E4%BB%95%E4%BA%8B/x.md';
    expect(hrefToRelative(baseUrl, vault, href)).toBe('05_仕事/x.md');
  });

  it('returns "" for the base folder itself', () => {
    const href = '/nextcloud/remote.php/dav/files/siosig/Documents/obsidian/Obsidian%20Vault/';
    expect(hrefToRelative(baseUrl, vault, href)).toBe('');
  });

  it('returns null for entries outside the base folder', () => {
    const href = '/nextcloud/remote.php/dav/files/siosig/Documents/obsidian/Other%20Vault/a.md';
    expect(hrefToRelative(baseUrl, vault, href)).toBeNull();
  });

  it('accepts an absolute-URL href as well as an absolute-path href', () => {
    const href = 'https://example.com/nextcloud/remote.php/dav/files/siosig/Documents/obsidian/Obsidian%20Vault/b.md';
    expect(hrefToRelative(baseUrl, vault, href)).toBe('b.md');
  });

  it('works when the Server URL is exactly the files root (no extra sub-path)', () => {
    const rootBase = 'https://host/remote.php/dav/files/siosig';
    const href = '/remote.php/dav/files/siosig/Obsidian%20Vault/c.md';
    expect(hrefToRelative(rootBase, vault, href)).toBe('c.md');
  });

  it('round-trips with toRemotePath/fromRemotePath for the relative form', () => {
    const rel = '01_daily/a.md';
    expect(fromRemotePath(vault, toRemotePath(vault, rel))).toBe(rel);
  });
});
