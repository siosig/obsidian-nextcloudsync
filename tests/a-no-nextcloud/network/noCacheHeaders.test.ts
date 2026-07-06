import { requestUrl } from 'obsidian';
import { NO_CACHE_HEADERS } from '../../../src/network/noCacheHeaders';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { DEFAULT_SETTINGS, DavSyncSettings, FileVersion } from '../../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

function res(status: number, over: Partial<{ text: string; json: unknown; arrayBuffer: ArrayBuffer; headers: Record<string, string> }> = {}) {
  return Promise.resolve({ status, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {}, ...over });
}

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'dev-1234',
};

describe('NO_CACHE_HEADERS', () => {
  it('contains exactly Cache-Control: no-store and Pragma: no-cache', () => {
    expect(NO_CACHE_HEADERS).toEqual({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    expect(Object.keys(NO_CACHE_HEADERS)).toHaveLength(2);
  });
});

describe('downloadFile requestUrl headers (no-cache)', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('NextcloudClient.downloadFile sends Cache-Control: no-store and Pragma: no-cache', async () => {
    mockRequestUrl.mockReturnValueOnce(res(200, { arrayBuffer: new TextEncoder().encode('hello').buffer }));
    const client = new NextcloudClient(settings, 'app-pw', 'Vault');
    await client.downloadFile('note.md');
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.method).toBe('GET');
    expect(call.headers).toMatchObject({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  });

  it('StandardWebDAVClient.downloadFile sends Cache-Control: no-store and Pragma: no-cache', async () => {
    mockRequestUrl.mockReturnValueOnce(res(200, { arrayBuffer: new TextEncoder().encode('hello').buffer }));
    const client = new StandardWebDAVClient(settings, 'pw', 'Vault');
    await client.downloadFile('note.md');
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.method).toBe('GET');
    expect(call.headers).toMatchObject({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  });
});

// ── T008 / T009: every remaining requestUrl call (all methods except downloadFile, already
// covered above) must also carry NO_CACHE_HEADERS. RED until the clients are patched (later task). ──

const EMPTY_MULTISTATUS = '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"></d:multistatus>';

/** All requestUrl calls recorded so far in the current test. */
function allCalls(): Array<{ method?: string; headers?: Record<string, string> }> {
  return mockRequestUrl.mock.calls.map((c) => c[0]);
}

/** Asserts at least one call was recorded and every one of them carries NO_CACHE_HEADERS. */
function expectAllCallsNoCache(): void {
  const calls = allCalls();
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.headers).toMatchObject(NO_CACHE_HEADERS);
  }
}

describe('T008: NextcloudClient remaining methods send NO_CACHE_HEADERS', () => {
  // NextcloudClient parses PROPFIND/REPORT XML with `new DOMParser()`. The a-layer `node` env has
  // none (only b1 polyfills it), so provide it from @xmldom/xmldom for the parsing assertions here
  // (see tests/a-no-nextcloud/sync/rootEtagShortcircuit.test.ts for the same pattern).
  let prevDOMParser: unknown;
  beforeAll(() => {
    prevDOMParser = (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- test-only polyfill
    (globalThis as unknown as { DOMParser: unknown }).DOMParser = require('@xmldom/xmldom').DOMParser;
  });
  afterAll(() => { (globalThis as unknown as { DOMParser: unknown }).DOMParser = prevDOMParser; });
  beforeEach(() => mockRequestUrl.mockReset());

  function makeClient(diag?: (msg: string) => void): NextcloudClient {
    return new NextcloudClient(settings, 'app-pw', 'Vault', diag);
  }

  it('connect() sends NO_CACHE_HEADERS on the status/capabilities/sync-token calls', async () => {
    mockRequestUrl
      .mockReturnValueOnce(res(200, { json: { maintenance: false } })) // GET /status.php
      .mockReturnValueOnce(res(200, { json: {} })) // GET capabilities
      .mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS })); // REPORT (getSyncToken)
    await makeClient().connect();
    expectAllCallsNoCache();
  });

  it('getFiles() sends NO_CACHE_HEADERS on the PROPFIND call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS }));
    await makeClient().getFiles('');
    expectAllCallsNoCache();
  });

  it('getRootEtag() sends NO_CACHE_HEADERS on the PROPFIND call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS }));
    await makeClient().getRootEtag();
    expectAllCallsNoCache();
  });

  it('getDirectories() sends NO_CACHE_HEADERS on the PROPFIND call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS }));
    await makeClient().getDirectories('');
    expectAllCallsNoCache();
  });

  it('isRemoteDirEmpty() sends NO_CACHE_HEADERS on the PROPFIND call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS }));
    await makeClient().isRemoteDirEmpty('Notes');
    expectAllCallsNoCache();
  });

  it('createDirectory() sends NO_CACHE_HEADERS on every MKCOL call', async () => {
    mockRequestUrl.mockReturnValue(res(201));
    await makeClient().createDirectory('Deep/Nested');
    expectAllCallsNoCache();
  });

  it('deleteCollection() sends NO_CACHE_HEADERS on the DELETE call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(204));
    await makeClient().deleteCollection('Notes');
    expectAllCallsNoCache();
  });

  it('getChanges() sends NO_CACHE_HEADERS on the REPORT call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS }));
    await makeClient().getChanges('token-1');
    expectAllCallsNoCache();
  });

  it('uploadFile() sends NO_CACHE_HEADERS on the PUT call (happy path)', async () => {
    mockRequestUrl.mockReturnValueOnce(res(201));
    await makeClient().uploadFile('Notes/a.md', new ArrayBuffer(2), 1000);
    expectAllCallsNoCache();
  });

  it('uploadFile() sends NO_CACHE_HEADERS on the MKCOL retry and the retried PUT (409 missing parent)', async () => {
    let putCount = 0;
    mockRequestUrl.mockImplementation((req: { method: string }) => {
      if (req.method === 'PUT') {
        putCount++;
        return res(putCount === 1 ? 409 : 201);
      }
      return res(201); // MKCOL
    });
    await makeClient().uploadFile('Deep/Nested/a.md', new ArrayBuffer(2));
    expectAllCallsNoCache();
  });

  it('recalcChecksum() sends NO_CACHE_HEADERS on the PATCH call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(204, { headers: { 'oc-checksum': 'SHA256:abc123' } }));
    await makeClient().recalcChecksum('Notes/a.md');
    expectAllCallsNoCache();
  });

  it('moveFile() sends NO_CACHE_HEADERS on the MKCOL and MOVE calls', async () => {
    mockRequestUrl.mockReturnValue(res(201));
    await makeClient().moveFile('a.md', 'b.md');
    expectAllCallsNoCache();
  });

  it('deleteFile() sends NO_CACHE_HEADERS on the DELETE call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(404));
    await makeClient().deleteFile('gone.md', 'rid');
    expectAllCallsNoCache();
  });

  it('getSyncToken() sends NO_CACHE_HEADERS on the REPORT call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS }));
    await makeClient().getSyncToken();
    expectAllCallsNoCache();
  });

  it('remoteExists() sends NO_CACHE_HEADERS on the PROPFIND call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(200));
    await makeClient().remoteExists('Notes/a.md');
    expectAllCallsNoCache();
  });

  it('listVersions() sends NO_CACHE_HEADERS on the PROPFIND call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS }));
    await makeClient().listVersions('123');
    expectAllCallsNoCache();
  });

  it('getVersionContent() sends NO_CACHE_HEADERS on the GET call', async () => {
    const buf = new TextEncoder().encode('hello').buffer;
    mockRequestUrl.mockReturnValueOnce(res(200, { arrayBuffer: buf }));
    const version: FileVersion = { versionId: '169000', href: '/v/123/169000', lastModified: 1, size: 5 };
    await makeClient().getVersionContent(version, '123');
    expectAllCallsNoCache();
  });

  it('restoreVersion() sends NO_CACHE_HEADERS on the MOVE call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(201));
    const version: FileVersion = { versionId: '169000', href: '/v/123/169000', lastModified: 1, size: 5 };
    await makeClient().restoreVersion(version, '123');
    expectAllCallsNoCache();
  });

  it('uploadChunked() sends NO_CACHE_HEADERS on every MKCOL/PUT/MOVE/PROPFIND call', async () => {
    // Order: MKCOL (session) -> PUT (single chunk, data fits in one) -> MKCOL (ensureRemoteDir
    // ancestor) -> MOVE (assemble) -> PROPFIND (verifyRemoteChecksum, 404 short-circuits it).
    mockRequestUrl
      .mockReturnValueOnce(res(201)) // MKCOL session
      .mockReturnValueOnce(res(201)) // PUT chunk
      .mockReturnValueOnce(res(201)) // MKCOL ensureRemoteDir
      .mockReturnValueOnce(res(201)) // MOVE assemble
      .mockReturnValueOnce(res(404)); // PROPFIND verify (skips comparison)
    await makeClient().uploadChunked('a.md', new ArrayBuffer(4), 1024);
    expectAllCallsNoCache();
  });

  it('lockFile() sends NO_CACHE_HEADERS on the LOCK call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(200, { text: '<?xml version="1.0"?><d:prop xmlns:d="DAV:"></d:prop>' }));
    await makeClient().lockFile('Notes/a.md');
    expectAllCallsNoCache();
  });

  it('unlockFile() sends NO_CACHE_HEADERS on the UNLOCK call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(200));
    await makeClient().unlockFile('Notes/a.md', 'lock-token-1');
    expectAllCallsNoCache();
  });
});

describe('T009: StandardWebDAVClient remaining methods send NO_CACHE_HEADERS', () => {
  // See the T008 describe block above: StandardWebDAVClient's PROPFIND parsing also needs a
  // DOMParser polyfill in the a-layer `node` test env.
  let prevDOMParser: unknown;
  beforeAll(() => {
    prevDOMParser = (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- test-only polyfill
    (globalThis as unknown as { DOMParser: unknown }).DOMParser = require('@xmldom/xmldom').DOMParser;
  });
  afterAll(() => { (globalThis as unknown as { DOMParser: unknown }).DOMParser = prevDOMParser; });
  beforeEach(() => mockRequestUrl.mockReset());

  function makeClient(): StandardWebDAVClient {
    return new StandardWebDAVClient(settings, 'pw', 'Vault');
  }

  it('connect() sends NO_CACHE_HEADERS on the PROPFIND call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(207));
    await makeClient().connect();
    expectAllCallsNoCache();
  });

  it('getFiles() sends NO_CACHE_HEADERS on the PROPFIND call (propfindRecursive)', async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS }));
    await makeClient().getFiles('');
    expectAllCallsNoCache();
  });

  it('getDirectories() sends NO_CACHE_HEADERS on the PROPFIND call (dirsRecursive)', async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS }));
    await makeClient().getDirectories('');
    expectAllCallsNoCache();
  });

  it('isRemoteDirEmpty() sends NO_CACHE_HEADERS on the PROPFIND call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(207, { text: EMPTY_MULTISTATUS }));
    await makeClient().isRemoteDirEmpty('Notes');
    expectAllCallsNoCache();
  });

  it('createDirectory() sends NO_CACHE_HEADERS on every MKCOL call', async () => {
    mockRequestUrl.mockReturnValue(res(201));
    await makeClient().createDirectory('Deep/Nested');
    expectAllCallsNoCache();
  });

  it('deleteCollection() sends NO_CACHE_HEADERS on the DELETE call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(204));
    await makeClient().deleteCollection('Notes');
    expectAllCallsNoCache();
  });

  it('uploadFile() sends NO_CACHE_HEADERS on the PUT call (happy path)', async () => {
    mockRequestUrl.mockReturnValueOnce(res(201));
    await makeClient().uploadFile('Notes/a.md', new ArrayBuffer(2), 1000);
    expectAllCallsNoCache();
  });

  it('uploadFile() sends NO_CACHE_HEADERS on the MKCOL retry and the retried PUT (409 missing parent)', async () => {
    let putCount = 0;
    mockRequestUrl.mockImplementation((req: { method: string }) => {
      if (req.method === 'PUT') {
        putCount++;
        return res(putCount === 1 ? 409 : 201);
      }
      return res(201); // MKCOL
    });
    await makeClient().uploadFile('Deep/Nested/a.md', new ArrayBuffer(2));
    expectAllCallsNoCache();
  });

  it('moveFile() sends NO_CACHE_HEADERS on the MKCOL and MOVE calls', async () => {
    mockRequestUrl.mockReturnValue(res(201));
    await makeClient().moveFile('a.md', 'b.md');
    expectAllCallsNoCache();
  });

  it('deleteFile() sends NO_CACHE_HEADERS on the DELETE call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(404));
    await makeClient().deleteFile('gone.md', 'rid');
    expectAllCallsNoCache();
  });

  it('remoteExists() sends NO_CACHE_HEADERS on the PROPFIND call', async () => {
    mockRequestUrl.mockReturnValueOnce(res(200));
    await makeClient().remoteExists('Notes/a.md');
    expectAllCallsNoCache();
  });
});
