// feature 090 (specs/090-server-lock-force-resolve/contracts/lockdiscovery-propfind.md)
// No [SPEC:...] tags: the clauses this serves are claimed once specs/main/spec.md is updated
// (see tests/a-no-nextcloud/network/dav/propfind.test.ts for the same convention).
//
// NextcloudClient.uploadFile (PUT) / deleteFile (DELETE): on a 423 response, one extra Depth:0
// lockdiscovery PROPFIND is issued to the same path. If it comes back 207 with a readable lock
// owner, a ServerLockedError (carrying the owner) is thrown instead of a plain NetworkError. Any
// failure of that extra lookup (non-207, owner unreadable) MUST fall back to exactly the original
// plain NetworkError('HTTP 423 (<method>)') — the lookup must never replace or hide the original
// 423 with something worse (contract "呼び出し側の契約", FR-004).
import { requestUrl } from 'obsidian';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, DavSyncSettings, NetworkError, ServerLockedError } from '../../../src/types';

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

const REMOTE_PATH = 'Notes/a.md';
const HREF = '/remote.php/dav/files/alice/Vault/Notes/a.md';
const OWNER = 'Bob Example';

const LOCKDISCOVERY_WITH_OWNER = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:" xmlns:nc="http://nextcloud.org/ns">
  <D:response>
    <D:href>${HREF}</D:href>
    <D:propstat>
      <D:prop>
        <D:lockdiscovery>
          <D:activelock>
            <D:lockscope><D:exclusive/></D:lockscope>
            <D:locktype><D:write/></D:locktype>
            <D:owner>${OWNER}</D:owner>
            <D:timeout>Infinite</D:timeout>
          </D:activelock>
        </D:lockdiscovery>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

const LOCKDISCOVERY_NO_OWNER = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${HREF}</D:href>
    <D:propstat>
      <D:prop>
        <D:lockdiscovery/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

function makeClient(): NextcloudClient {
  return new NextcloudClient(settings, 'app-pw', 'Vault');
}

describe('NextcloudClient — 423 lockdiscovery lookup (feature 090)', () => {
  // Parsing the lockdiscovery PROPFIND response needs a DOMParser polyfill in the a-layer `node`
  // test env (see tests/a-no-nextcloud/network/statFile.test.ts for the same pattern).
  let prevDOMParser: unknown;
  beforeAll(() => {
    prevDOMParser = (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- test-only polyfill
    (globalThis as unknown as { DOMParser: unknown }).DOMParser = require('@xmldom/xmldom').DOMParser;
  });
  afterAll(() => { (globalThis as unknown as { DOMParser: unknown }).DOMParser = prevDOMParser; });
  beforeEach(() => mockRequestUrl.mockReset());

  describe('uploadFile (PUT)', () => {
    it('[SPEC:SLE-1] 423 then lockdiscovery PROPFIND 207 with an owner -> rejects with ServerLockedError carrying the owner', async () => {
      mockRequestUrl
        .mockReturnValueOnce(res(423, { text: 'Locked' })) // PUT
        .mockReturnValueOnce(res(207, { text: LOCKDISCOVERY_WITH_OWNER })); // lockdiscovery PROPFIND

      const err: unknown = await makeClient().uploadFile(REMOTE_PATH, new ArrayBuffer(2)).catch((e) => e);

      expect(err).toBeInstanceOf(ServerLockedError);
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as Error).message).toContain('HTTP 423 (PUT)');
      expect((err as Error).message).toContain(OWNER);
      expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    });

    it('[SPEC:SLE-2] 423 then lockdiscovery PROPFIND fails (non-207) -> falls back to a plain NetworkError, not a ServerLockedError', async () => {
      mockRequestUrl
        .mockReturnValueOnce(res(423, { text: 'Locked' })) // PUT
        .mockReturnValueOnce(res(500, { text: 'boom' })); // lockdiscovery PROPFIND fails

      const err: unknown = await makeClient().uploadFile(REMOTE_PATH, new ArrayBuffer(2)).catch((e) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect(err).not.toBeInstanceOf(ServerLockedError);
      expect((err as Error).message).toBe('HTTP 423 (PUT)');
    });

    it('[SPEC:SLE-2] 423 then lockdiscovery PROPFIND 207 but no readable owner -> falls back to a plain NetworkError', async () => {
      mockRequestUrl
        .mockReturnValueOnce(res(423, { text: 'Locked' })) // PUT
        .mockReturnValueOnce(res(207, { text: LOCKDISCOVERY_NO_OWNER })); // no owner in body

      const err: unknown = await makeClient().uploadFile(REMOTE_PATH, new ArrayBuffer(2)).catch((e) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect(err).not.toBeInstanceOf(ServerLockedError);
      expect((err as Error).message).toBe('HTTP 423 (PUT)');
    });

    it('[SPEC:SLE-3] a non-423 error status (e.g. 500) is unaffected: no extra PROPFIND is issued, plain NetworkError is thrown', async () => {
      mockRequestUrl.mockReturnValueOnce(res(500, { text: 'boom' })); // PUT

      const err: unknown = await makeClient().uploadFile(REMOTE_PATH, new ArrayBuffer(2)).catch((e) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect(err).not.toBeInstanceOf(ServerLockedError);
      expect((err as Error).message).toBe('HTTP 500 (PUT)');
      expect(mockRequestUrl).toHaveBeenCalledTimes(1); // no extra lockdiscovery PROPFIND for non-423
    });
  });

  describe('deleteFile (DELETE)', () => {
    it('[SPEC:SLE-4] 423 then lockdiscovery PROPFIND 207 with an owner -> rejects with ServerLockedError carrying the owner', async () => {
      mockRequestUrl
        .mockReturnValueOnce(res(423, { text: 'Locked' })) // DELETE
        .mockReturnValueOnce(res(207, { text: LOCKDISCOVERY_WITH_OWNER })); // lockdiscovery PROPFIND

      const err: unknown = await makeClient().deleteFile(REMOTE_PATH, 'rid').catch((e) => e);

      expect(err).toBeInstanceOf(ServerLockedError);
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as Error).message).toContain('HTTP 423 (DELETE)');
      expect((err as Error).message).toContain(OWNER);
      expect(mockRequestUrl).toHaveBeenCalledTimes(2);
    });

    it('[SPEC:SLE-5] 423 then lockdiscovery PROPFIND fails (non-207) -> falls back to a plain NetworkError, not a ServerLockedError', async () => {
      mockRequestUrl
        .mockReturnValueOnce(res(423, { text: 'Locked' })) // DELETE
        .mockReturnValueOnce(res(500, { text: 'boom' })); // lockdiscovery PROPFIND fails

      const err: unknown = await makeClient().deleteFile(REMOTE_PATH, 'rid').catch((e) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect(err).not.toBeInstanceOf(ServerLockedError);
      expect((err as Error).message).toBe('HTTP 423 (DELETE)');
    });

    it('[SPEC:SLE-5] 423 then lockdiscovery PROPFIND 207 but no readable owner -> falls back to a plain NetworkError', async () => {
      mockRequestUrl
        .mockReturnValueOnce(res(423, { text: 'Locked' })) // DELETE
        .mockReturnValueOnce(res(207, { text: LOCKDISCOVERY_NO_OWNER })); // no owner in body

      const err: unknown = await makeClient().deleteFile(REMOTE_PATH, 'rid').catch((e) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect(err).not.toBeInstanceOf(ServerLockedError);
      expect((err as Error).message).toBe('HTTP 423 (DELETE)');
    });

    it('[SPEC:SLE-6] a non-423 error status (e.g. 500) is unaffected: no extra PROPFIND is issued, plain NetworkError is thrown', async () => {
      mockRequestUrl.mockReturnValueOnce(res(500, { text: 'boom' })); // DELETE

      const err: unknown = await makeClient().deleteFile(REMOTE_PATH, 'rid').catch((e) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect(err).not.toBeInstanceOf(ServerLockedError);
      expect((err as Error).message).toBe('HTTP 500 (DELETE)');
      expect(mockRequestUrl).toHaveBeenCalledTimes(1); // no extra lockdiscovery PROPFIND for non-423
    });
  });
});
