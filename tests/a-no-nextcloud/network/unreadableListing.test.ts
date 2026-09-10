// Feature 087 (issue #51): a 207 response whose body cannot be read as a listing must never be
// mistaken for a listing that says "nothing here". Both IWebDAVClient implementations funnel every
// PROPFIND/REPORT body through parseResponses (see propfind.test.ts for the parser-level cases);
// this file is the client-level guarantee — that getFiles / getDirectories / statFile / getChanges
// throw RemoteListingUnreadableError instead of quietly returning [] / null / an empty change set,
// while a genuinely empty or non-empty listing is unaffected.
import { requestUrl } from 'obsidian';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { IWebDAVClient } from '../../../src/network/IWebDAVClient';
import { DEFAULT_SETTINGS, DavSyncSettings, NetworkError, RemoteListingUnreadableError } from '../../../src/types';
import { installBrowserLikeDOMParser } from '../support/browserLikeDOMParser';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const res = (status: number, text = '') =>
  Promise.resolve({ status, text, json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'device-abcd1234',
};

const EMPTY_MULTISTATUS = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/remote.php/dav/files/alice/Vault/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

const NONEMPTY_MULTISTATUS = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response><d:href>/remote.php/dav/files/alice/Vault/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response><d:href>/remote.php/dav/files/alice/Vault/a.md</d:href>
    <d:propstat><d:prop><d:getetag>"e"</d:getetag><d:getcontentlength>7</d:getcontentlength>
    <d:getlastmodified>Mon, 12 Jan 2026 10:00:00 GMT</d:getlastmodified><d:resourcetype/>
    <oc:checksums>SHA256:aabbcc</oc:checksums><oc:fileid>1</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

/** The four ways a 207 body can fail to be a listing (data-model.md §応答本文の分類). */
const UNREADABLE_BODIES: ReadonlyArray<[string, string]> = [
  ['an empty body', ''],
  ['a truncated document', '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:respo'],
  ['an HTML error page from a proxy', '<html><body>502 Bad Gateway</body></html>'],
  ['well-formed XML with the wrong root', '<?xml version="1.0"?><foo/>'],
];

const CLIENTS: ReadonlyArray<[string, (base: string) => IWebDAVClient]> = [
  ['NextcloudClient', (base) => new NextcloudClient(settings, 'pw', base)],
  ['StandardWebDAVClient', (base) => new StandardWebDAVClient(settings, 'pw', base)],
];

describe('IWebDAVClient — an unreadable listing is a failure, not an empty one (feature 087)', () => {
  const dom = installBrowserLikeDOMParser();
  afterAll(() => dom.restore());
  beforeEach(() => mockRequestUrl.mockReset());

  describe.each(CLIENTS)('%s', (_name, makeClient) => {
    describe.each(UNREADABLE_BODIES)('ULG-7 ULG-8 ULG-9 %s', (_label, body) => {
      it('getFiles throws RemoteListingUnreadableError instead of returning []', async () => {
        mockRequestUrl.mockReturnValueOnce(res(207, body));
        const err: unknown = await makeClient('Vault').getFiles('').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RemoteListingUnreadableError);
        expect(err).toBeInstanceOf(NetworkError);
        const e = err as RemoteListingUnreadableError;
        expect(e.status).toBe(207);
        expect(e.method).toBe('PROPFIND');
        expect(e.op).toBe('getFiles');
        expect(e.body).toBe('');
      });

      it('getDirectories throws RemoteListingUnreadableError instead of returning []', async () => {
        mockRequestUrl.mockReturnValueOnce(res(207, body));
        const err: unknown = await makeClient('Vault').getDirectories('').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RemoteListingUnreadableError);
        expect((err as RemoteListingUnreadableError).op).toBe('getDirectories');
      });

      it('statFile throws RemoteListingUnreadableError instead of returning null', async () => {
        mockRequestUrl.mockReturnValueOnce(res(207, body));
        const err: unknown = await makeClient('Vault').statFile('a.md').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RemoteListingUnreadableError);
        expect((err as RemoteListingUnreadableError).op).toBe('statFile');
        expect((err as RemoteListingUnreadableError).path).toBe('a.md');
      });
    });

    it('getFiles still returns [] for a genuinely empty listing (feature 083 unaffected)', async () => {
      mockRequestUrl.mockReturnValueOnce(res(207, EMPTY_MULTISTATUS));
      await expect(makeClient('Vault').getFiles('')).resolves.toEqual([]);
    });

    it('getFiles still returns the real entries for a non-empty listing', async () => {
      mockRequestUrl.mockReturnValueOnce(res(207, NONEMPTY_MULTISTATUS));
      const files = await makeClient('Vault').getFiles('');
      expect(files.map((f) => f.path)).toEqual(['a.md']);
    });
  });

  describe('ULG-10 ULG-11 Nextcloud-specific calls', () => {
    function nc(): NextcloudClient {
      return new NextcloudClient(settings, 'app-pw', 'Vault');
    }

    it.each(UNREADABLE_BODIES)('getChanges throws for %s instead of an empty change set', async (_label, body) => {
      mockRequestUrl.mockReturnValueOnce(res(207, body));
      const err: unknown = await nc().getChanges('token').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteListingUnreadableError);
      const e = err as RemoteListingUnreadableError;
      expect(e.op).toBe('getChanges');
      expect(e.method).toBe('REPORT');
    });

    // getRootEtag and isRemoteDirEmpty were already safe on an unreadable body (they read it via
    // their own try/catch into null / false). The point here is that they now go through the SAME
    // validated reader as everything else, so their safety is legible in the code, not incidental —
    // and still produces the unchanged result.
    it.each(UNREADABLE_BODIES)('getRootEtag still resolves to null for %s (unchanged, root-cause visible)', async (_label, body) => {
      mockRequestUrl.mockReturnValueOnce(res(207, body));
      await expect(nc().getRootEtag()).resolves.toBeNull();
    });

    it.each(UNREADABLE_BODIES)('isRemoteDirEmpty still resolves to false for %s (never trash on ambiguity)', async (_label, body) => {
      mockRequestUrl.mockReturnValueOnce(res(207, body));
      await expect(nc().isRemoteDirEmpty('Some/Dir')).resolves.toBe(false);
    });
  });

  describe('ULG-18 StandardWebDAVClient recursion never yields a partial listing', () => {
    it('an unreadable body from a subfolder fails the whole getFiles call, not just that branch', async () => {
      const ROOT_WITH_SUBFOLDER = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
        <d:response><d:href>/remote.php/dav/files/alice/Vault/</d:href>
          <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
        <d:response><d:href>/remote.php/dav/files/alice/Vault/top.md</d:href>
          <d:propstat><d:prop><d:getetag>"e"</d:getetag><d:getcontentlength>1</d:getcontentlength>
          <d:getlastmodified>Mon, 12 Jan 2026 10:00:00 GMT</d:getlastmodified><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
        <d:response><d:href>/remote.php/dav/files/alice/Vault/sub/</d:href>
          <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response>
      </d:multistatus>`;
      const client = new StandardWebDAVClient(settings, 'pw', 'Vault');
      mockRequestUrl
        .mockReturnValueOnce(res(207, ROOT_WITH_SUBFOLDER)) // root: 1 file + 1 subfolder — looks fine
        .mockReturnValueOnce(res(207, '')); // recursing into the subfolder: unreadable

      const err: unknown = await client.getFiles('').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteListingUnreadableError);
    });
  });

  describe('ULG-12 the diagnostic message is a single line and never carries the body verbatim', () => {
    it('names the call, the path, the status, and a bounded fragment — nothing past 256 characters', async () => {
      const earlyMarker = 'EARLYMARKER'; // well inside the first 256 characters
      const lateMarker = 'LATEMARKER'; // padded out past 256 characters — must never reach the message
      const longBody = `<html><body>502 Bad Gateway ${earlyMarker} ${'y'.repeat(400)}${lateMarker}</body></html>`;
      mockRequestUrl.mockReturnValueOnce(res(207, longBody));
      const err: unknown = await new NextcloudClient(settings, 'pw', 'Vault').getFiles('').catch((e: unknown) => e);
      const e = err as RemoteListingUnreadableError;

      expect(e.message).not.toContain('\n');
      expect(e.message).toContain("getFiles ''");
      expect(e.message).toContain('HTTP 207');
      expect(e.message).toContain(`${new TextEncoder().encode(longBody).length} bytes`);
      expect(e.message).toContain(earlyMarker);
      expect(e.message).not.toContain(lateMarker);
      expect(e.bodyLength).toBe(new TextEncoder().encode(longBody).length);
    });

    it('counts bytes, not characters, for a multi-byte body', async () => {
      const body = `<html>${'ノ'.repeat(10)}</html>`; // each ノ is 3 bytes in UTF-8
      mockRequestUrl.mockReturnValueOnce(res(207, body));
      const err: unknown = await new NextcloudClient(settings, 'pw', 'Vault').getFiles('').catch((e: unknown) => e);
      expect((err as RemoteListingUnreadableError).bodyLength).toBe(new TextEncoder().encode(body).length);
      expect((err as RemoteListingUnreadableError).bodyLength).toBeGreaterThan(body.length);
    });
  });
});
