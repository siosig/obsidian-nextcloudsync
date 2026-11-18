// [SPEC:CT-14] Plain WebDAV (StandardWebDAVClient) has no creation-time property: an upload never sends X-OC-CTime,
// setCreationTime sends no request and answers 'rejected', and listings carry no creationTime (docs/spec.md §9.7).
import { DOMParser } from '@xmldom/xmldom';
import { requestUrl } from 'obsidian';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

// Parsing a listing needs a DOMParser, which the a-layer node environment lacks.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'dev-1234',
};

function res(status: number, over: Partial<{ text: string }> = {}) {
  return Promise.resolve({ status, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {}, ...over });
}

const LISTING = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/Vault/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/Vault/a.md</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-1"</d:getetag>
        <d:getcontentlength>42</d:getcontentlength>
        <d:getlastmodified>Mon, 12 Jan 2026 10:00:00 GMT</d:getlastmodified>
        <d:resourcetype/>
        <nc:creation_time>1700000000</nc:creation_time>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

describe('StandardWebDAVClient — no creation time on plain WebDAV [SPEC:CT-14]', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  const client = () => new StandardWebDAVClient(settings, () => 'pw', 'Vault');

  it('[SPEC:CT-14] uploadFile ignores opts.ctime and sends no X-OC-CTime header', async () => {
    mockRequestUrl.mockImplementation(() => res(201));
    await client().uploadFile('a.md', new ArrayBuffer(3), 1700000000000, { ctime: 1700000000000 });
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    const call = mockRequestUrl.mock.calls[0][0];
    expect(call.method).toBe('PUT');
    const names = Object.keys(call.headers).map((h) => h.toLowerCase());
    expect(names).not.toContain('x-oc-ctime');
    expect(call.headers['X-OC-MTime']).toBe('1700000000');
  });

  it('[SPEC:CT-14] setCreationTime sends no request and returns rejected', async () => {
    const result = await client().setCreationTime('a.md', 1700000000);
    expect(result).toBe('rejected');
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('[SPEC:CT-14] getFiles results carry no creationTime property', async () => {
    mockRequestUrl.mockImplementation(() => res(207, { text: LISTING }));
    const files = await client().getFiles('');
    expect(files.length).toBe(1);
    for (const r of files) expect('creationTime' in r).toBe(false);
  });
});
