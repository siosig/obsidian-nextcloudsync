import { requestUrl, RequestUrlParam } from 'obsidian';
import { NextcloudClient } from '../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../src/types';
import { sha256 } from '../../src/util/hash';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

// Server URL points at a sub-folder *below* the WebDAV files root — this is the configuration
// that previously broke remote-file recognition (everything was marked as upload).
const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/Documents/obsidian',
  username: 'alice',
  deviceId: 'device-abcd1234',
};

function methodsOf(method: string): RequestUrlParam[] {
  return mockRequestUrl.mock.calls.map(c => c[0]).filter(r => r.method === method);
}

describe('NextcloudClient — OC-Checksum on upload', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('sends OC-Checksum: SHA256:<hash> on PUT so the server persists it', async () => {
    mockRequestUrl.mockImplementation((req) => {
      // MKCOL (ensureRemoteDir) and PUT both succeed.
      return Promise.resolve({ status: 201, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
    });

    const data = new TextEncoder().encode('hello world').buffer as ArrayBuffer;
    await new NextcloudClient(settings, 'pw', 'Vault').uploadFile('Notes/a.md', data);

    const put = methodsOf('PUT')[0];
    expect(put).toBeDefined();
    expect(put.headers?.['OC-Checksum']).toBe(`SHA256:${await sha256(data)}`);
  });
});

describe('NextcloudClient.recalcChecksum', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('PATCHes with X-Recalculate-Hash and returns the lowercase hex from OC-Checksum', async () => {
    mockRequestUrl.mockImplementation((req) => {
      expect(req.method).toBe('PATCH');
      expect(req.headers?.['X-Recalculate-Hash']).toBe('sha256');
      return Promise.resolve({
        status: 204, text: '', json: {}, arrayBuffer: new ArrayBuffer(0),
        headers: { 'oc-checksum': 'SHA256:B61B63BCE612CEC583B2B4D2E5BB4317A5399F66E6B11A3D0BAA2E3B62BA02CB' },
      });
    });

    const sum = await new NextcloudClient(settings, 'pw', 'Vault').recalcChecksum('Notes/a.md');
    expect(sum).toBe('b61b63bce612cec583b2b4d2e5bb4317a5399f66e6b11a3d0baa2e3b62ba02cb');
  });

  it('returns null when the server does not provide a checksum', async () => {
    mockRequestUrl.mockResolvedValue({ status: 204, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
    const sum = await new NextcloudClient(settings, 'pw', 'Vault').recalcChecksum('Notes/a.md');
    expect(sum).toBeNull();
  });

  it('returns null on a non-2xx response (unsupported)', async () => {
    mockRequestUrl.mockResolvedValue({ status: 405, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
    const sum = await new NextcloudClient(settings, 'pw', 'Vault').recalcChecksum('Notes/a.md');
    expect(sum).toBeNull();
  });
});

describe('NextcloudClient.getSyncToken', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  // Regression: a `<d:sync-token>`-only regex returned null when the server used another XML
  // namespace prefix, which stranded sync in permanent full-scan mode (deletions never propagated).
  it.each([
    ['d:', '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:sync-token>http://nc/ns/sync/42</d:sync-token></d:multistatus>'],
    ['D:', '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:sync-token>http://nc/ns/sync/42</D:sync-token></D:multistatus>'],
    ['none', '<?xml version="1.0"?><multistatus xmlns="DAV:"><sync-token>http://nc/ns/sync/42</sync-token></multistatus>'],
    ['nc:', '<?xml version="1.0"?><nc:multistatus xmlns:nc="DAV:"><nc:sync-token> http://nc/ns/sync/42 </nc:sync-token></nc:multistatus>'],
  ])('extracts the sync-token regardless of namespace prefix (%s)', async (_label, body) => {
    mockRequestUrl.mockResolvedValue({ status: 207, text: body, json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
    const token = await new NextcloudClient(settings, 'pw', 'Vault').getSyncToken();
    expect(token).toBe('http://nc/ns/sync/42');
  });

  it('returns null when no token is present', async () => {
    mockRequestUrl.mockResolvedValue({ status: 207, text: '<d:multistatus xmlns:d="DAV:"></d:multistatus>', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
    expect(await new NextcloudClient(settings, 'pw', 'Vault').getSyncToken()).toBeNull();
  });

  it('returns null on a non-207 response', async () => {
    mockRequestUrl.mockResolvedValue({ status: 500, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
    expect(await new NextcloudClient(settings, 'pw', 'Vault').getSyncToken()).toBeNull();
  });

  // Nextcloud's files DAV has no sync-collection REPORT (415). After the first 415, the client
  // must skip the REPORT entirely (full-scan) instead of re-issuing a guaranteed-415 every sync.
  it('caches a 415 (sync-collection unsupported) and skips the REPORT thereafter', async () => {
    let calls = 0;
    mockRequestUrl.mockImplementation(() => {
      calls++;
      return Promise.resolve({ status: 415, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
    });
    const client = new NextcloudClient(settings, 'pw', 'Vault');
    expect(await client.getSyncToken()).toBeNull();
    expect(await client.getSyncToken()).toBeNull();
    expect(calls).toBe(1); // second call short-circuited — no REPORT sent
  });
});
