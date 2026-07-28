// [SPEC:WSF-1] specs/064-watch-single-file-conflict/contracts/watch-single-file-sync.md (C-0)
//
// Verifies IWebDAVClient.statFile() on both concrete implementations:
//   - NextcloudClient (reuses PROPFIND_BODY / parsePropfindResponse, adds oc:checksums / oc:fileid)
//   - StandardWebDAVClient (reuses parseListing)
//
// Contract table (C-0):
//   file exists (207, one entry)        -> RemoteFileInfo
//   file absent (404)                   -> null
//   target is a collection (folder)     -> null
//   any other non-207/404 status        -> NetworkError thrown (never null — an ambiguous failure
//                                          must not be read as "absent" and trigger a blind overwrite)
//   request is a Depth:0 PROPFIND        -> asserted via the requestUrl mock call args
import { requestUrl } from 'obsidian';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { DEFAULT_SETTINGS, DavSyncSettings, NetworkError } from '../../../src/types';

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

// Matches the href shape produced under settings.serverUrl + remoteBase 'Vault' for remotePath
// 'Notes/a.md': https://nc/remote.php/dav/files/alice/Vault/Notes/a.md
const REMOTE_PATH = 'Notes/a.md';
const HREF = '/remote.php/dav/files/alice/Vault/Notes/a.md';

const NC_FILE_MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>${HREF}</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-abc123"</d:getetag>
        <d:getcontentlength>42</d:getcontentlength>
        <d:getlastmodified>Mon, 12 Jan 2026 10:00:00 GMT</d:getlastmodified>
        <d:resourcetype/>
        <oc:checksums>SHA256:deadbeef00112233</oc:checksums>
        <oc:fileid>987</oc:fileid>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

const STANDARD_FILE_MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>${HREF}</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-abc123"</d:getetag>
        <d:getcontentlength>42</d:getcontentlength>
        <d:getlastmodified>Mon, 12 Jan 2026 10:00:00 GMT</d:getlastmodified>
        <d:resourcetype/>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

const COLLECTION_MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>${HREF.replace(/a\.md$/, '')}</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-dir"</d:getetag>
        <d:getlastmodified>Mon, 12 Jan 2026 10:00:00 GMT</d:getlastmodified>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

describe('IWebDAVClient.statFile (C-0)', () => {
  // Both clients' PROPFIND parsing needs a DOMParser polyfill in the a-layer `node` test env (see
  // tests/a-no-nextcloud/network/noCacheHeaders.test.ts for the same pattern).
  let prevDOMParser: unknown;
  beforeAll(() => {
    prevDOMParser = (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- test-only polyfill
    (globalThis as unknown as { DOMParser: unknown }).DOMParser = require('@xmldom/xmldom').DOMParser;
  });
  afterAll(() => { (globalThis as unknown as { DOMParser: unknown }).DOMParser = prevDOMParser; });
  beforeEach(() => mockRequestUrl.mockReset());

  describe('NextcloudClient.statFile', () => {
    function makeClient(): NextcloudClient {
      return new NextcloudClient(settings, 'app-pw', 'Vault');
    }

    it('returns a RemoteFileInfo with checksum/etag/size/lastModified/fileId on a 207 single-file response', async () => {
      mockRequestUrl.mockReturnValueOnce(res(207, { text: NC_FILE_MULTISTATUS }));
      const info = await makeClient().statFile(REMOTE_PATH);
      expect(info).toEqual({
        path: REMOTE_PATH,
        fileId: '987',
        checksum: 'deadbeef00112233',
        etag: 'etag-abc123',
        size: 42,
        lastModified: new Date('Mon, 12 Jan 2026 10:00:00 GMT').getTime(),
      });
    });

    it('returns null on 404 (file absent)', async () => {
      mockRequestUrl.mockReturnValueOnce(res(404));
      const info = await makeClient().statFile(REMOTE_PATH);
      expect(info).toBeNull();
    });

    it('returns null on 404 when the parent folder is absent too', async () => {
      mockRequestUrl.mockReturnValueOnce(res(404));
      const info = await makeClient().statFile('Missing/a.md');
      expect(info).toBeNull();
    });

    it('returns null when the target is a collection (folder), never treating it as a file', async () => {
      mockRequestUrl.mockReturnValueOnce(res(207, { text: COLLECTION_MULTISTATUS }));
      const info = await makeClient().statFile('Notes');
      expect(info).toBeNull();
    });

    it('throws NetworkError (not null) on a non-207/404 status such as 500', async () => {
      mockRequestUrl.mockReturnValueOnce(res(500, { text: 'boom' }));
      await expect(makeClient().statFile(REMOTE_PATH)).rejects.toBeInstanceOf(NetworkError);
    });

    it('sends a Depth:0 PROPFIND for the given path', async () => {
      mockRequestUrl.mockReturnValueOnce(res(207, { text: NC_FILE_MULTISTATUS }));
      await makeClient().statFile(REMOTE_PATH);
      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.method).toBe('PROPFIND');
      expect(call.headers.Depth).toBe('0');
    });
  });

  describe('StandardWebDAVClient.statFile', () => {
    function makeClient(): StandardWebDAVClient {
      return new StandardWebDAVClient(settings, 'pw', 'Vault');
    }

    it('returns a RemoteFileInfo with etag/size/lastModified on a 207 single-file response (checksum/fileId are always null, unsupported by plain WebDAV)', async () => {
      mockRequestUrl.mockReturnValueOnce(res(207, { text: STANDARD_FILE_MULTISTATUS }));
      const info = await makeClient().statFile(REMOTE_PATH);
      expect(info).toEqual({
        path: REMOTE_PATH,
        fileId: null,
        checksum: null,
        etag: 'etag-abc123',
        size: 42,
        lastModified: new Date('Mon, 12 Jan 2026 10:00:00 GMT').getTime(),
      });
    });

    it('returns null on 404 (file absent)', async () => {
      mockRequestUrl.mockReturnValueOnce(res(404));
      const info = await makeClient().statFile(REMOTE_PATH);
      expect(info).toBeNull();
    });

    it('returns null on 404 when the parent folder is absent too', async () => {
      mockRequestUrl.mockReturnValueOnce(res(404));
      const info = await makeClient().statFile('Missing/a.md');
      expect(info).toBeNull();
    });

    it('returns null when the target is a collection (folder), never treating it as a file', async () => {
      mockRequestUrl.mockReturnValueOnce(res(207, { text: COLLECTION_MULTISTATUS }));
      const info = await makeClient().statFile('Notes');
      expect(info).toBeNull();
    });

    it('throws NetworkError (not null) on a non-207/404 status such as 500', async () => {
      mockRequestUrl.mockReturnValueOnce(res(500, { text: 'boom' }));
      await expect(makeClient().statFile(REMOTE_PATH)).rejects.toBeInstanceOf(NetworkError);
    });

    it('sends a Depth:0 PROPFIND for the given path', async () => {
      mockRequestUrl.mockReturnValueOnce(res(207, { text: STANDARD_FILE_MULTISTATUS }));
      await makeClient().statFile(REMOTE_PATH);
      const call = mockRequestUrl.mock.calls[0][0];
      expect(call.method).toBe('PROPFIND');
      expect(call.headers.Depth).toBe('0');
    });
  });
});
