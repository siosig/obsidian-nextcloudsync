import { requestUrl } from 'obsidian';
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
