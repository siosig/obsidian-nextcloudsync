import { requestUrl } from 'obsidian';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { DEFAULT_SETTINGS, DavSyncSettings, NetworkError, ServerLockedError } from '../../../src/types';
import { installBrowserLikeDOMParser } from '../support/browserLikeDOMParser';

// jest's 'node' test environment has no DOMParser; readLockDiscoveryOwner (src/network/dav/propfind.ts)
// needs one to read the lockdiscovery PROPFIND body. Same installation as propfind.test.ts.
const dom = installBrowserLikeDOMParser();
afterAll(() => dom.restore());

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'device-abcd1234',
};

const res = (status: number, text = '') =>
  Promise.resolve({ status, text, json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });

const client = () => new StandardWebDAVClient(settings, 'pw', 'Vault');

const LOCK_OWNER = 'Alice (Text app)';

// A lockdiscovery PROPFIND 207 body carrying a readable RFC 4918 owner.
const LOCKDISCOVERY_WITH_OWNER = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:" xmlns:nc="http://nextcloud.org/ns">
  <D:response>
    <D:href>/remote.php/dav/files/alice/Vault/Notes/a.md</D:href>
    <D:propstat>
      <D:prop>
        <D:lockdiscovery>
          <D:activelock>
            <D:lockscope><D:exclusive/></D:lockscope>
            <D:locktype><D:write/></D:locktype>
            <D:owner>${LOCK_OWNER}</D:owner>
            <D:timeout>Infinite</D:timeout>
          </D:activelock>
        </D:lockdiscovery>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

// A 207 body with no activelock/owner at all — readLockDiscoveryOwner returns null for this.
const LOCKDISCOVERY_NO_OWNER = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/remote.php/dav/files/alice/Vault/Notes/a.md</D:href>
    <D:propstat>
      <D:prop><D:lockdiscovery/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

// [SPEC:...] issue #58: a PUT/DELETE answered 423 (server-side lock, not this plugin's own cooperative lock) triggers
// ONE extra Depth:0 lockdiscovery PROPFIND so the thrown error can name the lock holder. A failure in that extra step
// must fall back EXACTLY to the original plain NetworkError(423, ...); never suppress or replace the 423.
describe('StandardWebDAVClient — 423 lockdiscovery PROPFIND (feature 090)', () => {
  beforeEach(() => {
    mockRequestUrl.mockReset();
  });

  describe('uploadFile (PUT)', () => {
    it('[SPEC:SLE-7] PUT 423, then lockdiscovery PROPFIND 207 with owner -> rejects with ServerLockedError', async () => {
      mockRequestUrl.mockImplementation((params: { method?: string }) => {
        if (params.method === 'PUT') return res(423);
        if (params.method === 'PROPFIND') return res(207, LOCKDISCOVERY_WITH_OWNER);
        throw new Error(`unexpected method ${params.method}`);
      });

      const err = await client().uploadFile('Notes/a.md', new ArrayBuffer(2)).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect(err).toBeInstanceOf(ServerLockedError);
      expect((err as Error).message).toContain('HTTP 423 (PUT)');
      expect((err as Error).message).toContain(LOCK_OWNER);
    });

    it.each([
      ['the lockdiscovery PROPFIND itself fails (non-207)', () => res(500)],
      ['the lockdiscovery PROPFIND returns 207 but no owner', () => res(207, LOCKDISCOVERY_NO_OWNER)],
    ])('[SPEC:SLE-8] PUT 423, then %s -> falls back to a plain NetworkError (not ServerLockedError)', async (_desc, propfindRes) => {
      mockRequestUrl.mockImplementation((params: { method?: string }) => {
        if (params.method === 'PUT') return res(423);
        if (params.method === 'PROPFIND') return propfindRes();
        throw new Error(`unexpected method ${params.method}`);
      });

      const err = await client().uploadFile('Notes/a.md', new ArrayBuffer(2)).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect(err).not.toBeInstanceOf(ServerLockedError);
      expect((err as Error).message).toBe('HTTP 423 (PUT)');
    });

    it('[SPEC:SLE-9] a non-423 error status is unaffected and issues no extra PROPFIND', async () => {
      mockRequestUrl.mockImplementation(() => res(500));

      const err = await client().uploadFile('Notes/a.md', new ArrayBuffer(2)).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect(err).not.toBeInstanceOf(ServerLockedError);
      expect((err as Error).message).toBe('HTTP 500 (PUT)');
      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteFile (DELETE)', () => {
    it('[SPEC:SLE-10] DELETE 423, then lockdiscovery PROPFIND 207 with owner -> rejects with ServerLockedError', async () => {
      mockRequestUrl.mockImplementation((params: { method?: string }) => {
        if (params.method === 'DELETE') return res(423);
        if (params.method === 'PROPFIND') return res(207, LOCKDISCOVERY_WITH_OWNER);
        throw new Error(`unexpected method ${params.method}`);
      });

      const err = await client().deleteFile('Notes/a.md', 'rid').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect(err).toBeInstanceOf(ServerLockedError);
      expect((err as Error).message).toContain('HTTP 423 (DELETE)');
      expect((err as Error).message).toContain(LOCK_OWNER);
    });

    it.each([
      ['the lockdiscovery PROPFIND itself fails (non-207)', () => res(500)],
      ['the lockdiscovery PROPFIND returns 207 but no owner', () => res(207, LOCKDISCOVERY_NO_OWNER)],
    ])('[SPEC:SLE-11] DELETE 423, then %s -> falls back to a plain NetworkError (not ServerLockedError)', async (_desc, propfindRes) => {
      mockRequestUrl.mockImplementation((params: { method?: string }) => {
        if (params.method === 'DELETE') return res(423);
        if (params.method === 'PROPFIND') return propfindRes();
        throw new Error(`unexpected method ${params.method}`);
      });

      const err = await client().deleteFile('Notes/a.md', 'rid').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect(err).not.toBeInstanceOf(ServerLockedError);
      expect((err as Error).message).toBe('HTTP 423 (DELETE)');
    });

    it('[SPEC:SLE-12] a non-423 error status is unaffected and issues no extra PROPFIND', async () => {
      mockRequestUrl.mockImplementation(() => res(500));

      const err = await client().deleteFile('Notes/a.md', 'rid').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect(err).not.toBeInstanceOf(ServerLockedError);
      expect((err as Error).message).toBe('HTTP 500 (DELETE)');
      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    });
  });
});
