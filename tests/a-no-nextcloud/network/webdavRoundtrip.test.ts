import { requestUrl, Platform } from 'obsidian';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, DavSyncSettings, PreconditionFailedError, NetworkError } from '../../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'device-abcd1234',
};

const res = (status: number, headers: Record<string, string> = {}) =>
  Promise.resolve({ status, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers });

const calls = (method: string) => mockRequestUrl.mock.calls.map((c) => c[0]).filter((r) => r.method === method);

describe('NextcloudClient.uploadFile — P1-B round-trip reduction', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('sends If-Match with the provided etag and maps 412 to PreconditionFailedError', async () => {
    mockRequestUrl.mockImplementation(() => res(412));
    await expect(
      new NextcloudClient(settings, 'pw', 'Vault').uploadFile('Notes/a.md', new ArrayBuffer(2), 1000, { ifMatchEtag: 'etag-xyz' }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    const put = calls('PUT')[0];
    expect(put.headers?.['If-Match']).toBe('"etag-xyz"');
  });

  it('does NOT pre-probe directories on the happy path (PUT succeeds, no MKCOL)', async () => {
    mockRequestUrl.mockImplementation(() => res(201));
    await new NextcloudClient(settings, 'pw', 'Vault').uploadFile('Notes/a.md', new ArrayBuffer(2), 1000);
    expect(calls('PUT')).toHaveLength(1);
    expect(calls('MKCOL')).toHaveLength(0); // reactive: only created on a 409
  });

  it('reactively creates parents on 409, then retries the PUT once', async () => {
    let putCount = 0;
    mockRequestUrl.mockImplementation((req) => {
      if (req.method === 'PUT') { putCount++; return res(putCount === 1 ? 409 : 201); }
      if (req.method === 'MKCOL') return res(201);
      return res(201);
    });
    await new NextcloudClient(settings, 'pw', 'Vault').uploadFile('Deep/Nested/a.md', new ArrayBuffer(2));
    expect(calls('PUT')).toHaveLength(2);        // first 409, retry 201
    expect(calls('MKCOL').length).toBeGreaterThan(0); // ancestors created
  });

  // Nextcloud's files DAV returns 404 (not 409) for a missing parent — reactive MKCOL must
  // fire on 404 too, otherwise the first upload into a not-yet-created folder fails.
  it('reactively creates parents on 404 (Nextcloud missing-parent), then retries the PUT', async () => {
    let putCount = 0;
    mockRequestUrl.mockImplementation((req) => {
      if (req.method === 'PUT') { putCount++; return res(putCount === 1 ? 404 : 201); }
      if (req.method === 'MKCOL') return res(201);
      return res(201);
    });
    await new NextcloudClient(settings, 'pw', 'Vault').uploadFile('Deep/Nested/a.md', new ArrayBuffer(2));
    expect(calls('PUT')).toHaveLength(2);        // first 404, retry 201
    expect(calls('MKCOL').length).toBeGreaterThan(0);
  });

  it('reuses precomputedSha256 for the OC-Checksum header', async () => {
    mockRequestUrl.mockImplementation(() => res(201));
    await new NextcloudClient(settings, 'pw', 'Vault').uploadFile('a.md', new ArrayBuffer(2), undefined, { precomputedSha256: 'deadbeef' });
    expect(calls('PUT')[0].headers?.['OC-Checksum']).toBe('SHA256:deadbeef');
  });
});

describe('NextcloudClient.deleteFile — blind delete (P1-B)', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('treats 404 as success (already gone)', async () => {
    mockRequestUrl.mockImplementation(() => res(404));
    await expect(new NextcloudClient(settings, 'pw', 'Vault').deleteFile('gone.md', 'rid')).resolves.toBeUndefined();
  });

  it('still throws on a real failure (500)', async () => {
    mockRequestUrl.mockImplementation(() => res(500));
    await expect(new NextcloudClient(settings, 'pw', 'Vault').deleteFile('x.md', 'rid')).rejects.toBeInstanceOf(NetworkError);
  });
});

// [SPEC:URE-2]: feature 065 (issue #25). Every remote URL NextcloudClient builds goes through the
// one encoding scheme — including the MOVE Destination HEADER, which the request layer never
// touches on any platform, so a raw value there is unrecoverable. The pure function is covered in
// remotePath.test.ts; what these assert is the WIRING: that no call site bypasses it, and that no
// platform check can change the result. Platform.isIosApp is forced ON for the whole block: under
// feature 061 that flipped every expectation below, so if a platform branch is ever reintroduced
// these fail rather than silently pass on the desktop path.
describe('NextcloudClient — remote URL encoding is platform-independent (feature 065)', () => {
  const originalIsIosApp = Platform.isIosApp;
  const ENCODED = 'https://nc/remote.php/dav/files/alice/Vault/00%20%E6%94%B6%E4%BB%B6%E7%AE%B1/%E6%9C%AA%E5%91%BD%E5%90%8D.md';
  const RAW_PATH = '00 收件箱/未命名.md';

  beforeEach(() => {
    mockRequestUrl.mockReset();
    Platform.isIosApp = true; // the platform 061 special-cased; must make no difference now
  });
  afterEach(() => { Platform.isIosApp = originalIsIosApp; });

  const client = () => new NextcloudClient(settings, 'pw', 'Vault');

  it('PUT (upload) percent-encodes the path', async () => {
    mockRequestUrl.mockImplementation(() => res(201));
    await client().uploadFile(RAW_PATH, new ArrayBuffer(2));
    expect(calls('PUT')[0].url).toBe(ENCODED);
  });

  it('GET (download) percent-encodes the path', async () => {
    mockRequestUrl.mockImplementation(() => res(200));
    await client().downloadFile(RAW_PATH);
    expect(calls('GET')[0].url).toBe(ENCODED);
  });

  it('DELETE percent-encodes the path', async () => {
    mockRequestUrl.mockImplementation(() => res(204));
    await client().deleteFile(RAW_PATH, 'rid');
    expect(calls('DELETE')[0].url).toBe(ENCODED);
  });

  it('PROPFIND (statFile) percent-encodes the path', async () => {
    mockRequestUrl.mockImplementation(() => res(404));
    await client().statFile(RAW_PATH);
    expect(calls('PROPFIND')[0].url).toBe(ENCODED);
  });

  it('MKCOL (ensureRemoteDir) percent-encodes each ancestor segment', async () => {
    let put = 0;
    mockRequestUrl.mockImplementation((req: { method: string }) =>
      req.method === 'PUT' ? res(++put === 1 ? 409 : 201) : res(201));
    await client().uploadFile(RAW_PATH, new ArrayBuffer(2));
    const mkcols = calls('MKCOL').map((c) => c.url);
    expect(mkcols).toContain('https://nc/remote.php/dav/files/alice/Vault/00%20%E6%94%B6%E4%BB%B6%E7%AE%B1');
    expect(mkcols.some((u) => u.includes('00 收件箱'))).toBe(false);
  });

  it('MOVE percent-encodes BOTH the request url and the Destination header', async () => {
    mockRequestUrl.mockImplementation(() => res(201));
    await client().moveFile('a.md', RAW_PATH);
    const move = calls('MOVE')[0];
    expect(move.url).toBe('https://nc/remote.php/dav/files/alice/Vault/a.md');
    expect(move.headers?.Destination).toBe(ENCODED);
  });

  it('never emits a raw space or a double-encoded %25 on any request', async () => {
    mockRequestUrl.mockImplementation(() => res(201));
    await client().uploadFile(RAW_PATH, new ArrayBuffer(2));
    await client().moveFile('a.md', RAW_PATH);
    const urls = mockRequestUrl.mock.calls.flatMap((c) => [c[0].url, c[0].headers?.Destination ?? '']);
    for (const u of urls) {
      expect(u).not.toMatch(/ /);
      expect(u).not.toContain('%25');
    }
  });
});

// [SPEC:URE-4]: a Server URL whose trailing subfolder holds a space must not leak that space into
// request URLs, and one the user pasted already-encoded must not be encoded a second time.
describe('NextcloudClient — Server URL normalization (feature 065)', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('encodes a space in the configured Server URL', async () => {
    const s = { ...settings, serverUrl: 'https://nc/remote.php/dav/files/alice/My Folder/' };
    mockRequestUrl.mockImplementation(() => res(201));
    await new NextcloudClient(s, 'pw', 'Vault').uploadFile('a.md', new ArrayBuffer(2));
    expect(calls('PUT')[0].url).toBe('https://nc/remote.php/dav/files/alice/My%20Folder/Vault/a.md');
  });

  it('leaves an already-encoded Server URL alone (no %2520)', async () => {
    const s = { ...settings, serverUrl: 'https://nc/remote.php/dav/files/alice/My%20Folder/' };
    mockRequestUrl.mockImplementation(() => res(201));
    await new NextcloudClient(s, 'pw', 'Vault').uploadFile('a.md', new ArrayBuffer(2));
    expect(calls('PUT')[0].url).toBe('https://nc/remote.php/dav/files/alice/My%20Folder/Vault/a.md');
  });
});

// [SPEC:URE-5]: a bare "HTTP 404" cannot tell a failed download from a failed upload or PROPFIND —
// issue #25 produced 162 of them and the operation stayed unknown. The verb rides on the error.
describe('NextcloudClient — NetworkError carries the HTTP method (feature 065)', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it.each([
    ['GET', (c: NextcloudClient) => c.downloadFile('a.md'), 404],
    ['PUT', (c: NextcloudClient) => c.uploadFile('a.md', new ArrayBuffer(2)), 507],
    ['DELETE', (c: NextcloudClient) => c.deleteFile('a.md', 'rid'), 403],
    ['MOVE', (c: NextcloudClient) => c.moveFile('a.md', 'b.md'), 502],
  ])('%s failure surfaces as "HTTP <status> (%s)"', async (method, run, status) => {
    mockRequestUrl.mockImplementation((req: { method: string }) =>
      req.method === 'MKCOL' ? res(201) : res(status as number));
    const err = await run(new NextcloudClient(settings, 'pw', 'Vault')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).method).toBe(method);
    expect((err as NetworkError).message).toBe(`HTTP ${status} (${method})`);
    // The pre-065 shape stays a prefix, so anything matching on it keeps working.
    expect((err as NetworkError).message.startsWith(`HTTP ${status}`)).toBe(true);
  });

  it('keeps the bare "HTTP <status>" message when no method is supplied', () => {
    expect(new NetworkError(404, '').message).toBe('HTTP 404');
    expect(new NetworkError(404, '').method).toBeUndefined();
  });

  it('never puts the server response body into the message (logs get pasted into public issues)', () => {
    const err = new NetworkError(500, 'Basic YWxpY2U6c3VwZXJzZWNyZXQ=', 'PUT');
    expect(err.message).toBe('HTTP 500 (PUT)');
    expect(err.message).not.toContain('YWxpY2U');
  });
});
