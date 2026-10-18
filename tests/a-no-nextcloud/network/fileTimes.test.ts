import { installBrowserLikeDOMParser } from '../support/browserLikeDOMParser';
const dom = installBrowserLikeDOMParser();
afterAll(() => dom.restore());

import { requestUrl } from 'obsidian';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, PreconditionFailedError, RemoteFileInfo } from '../../../src/types';

const mock = requestUrl as unknown as jest.Mock;
const settings = { ...DEFAULT_SETTINGS, serverUrl: 'https://nc/remote.php/dav/files/alice/', username: 'alice' };
const ctime = 1577808000000, mtime = 1646092800000;
const remote: RemoteFileInfo = { path: 'note.md', size: 2, checksum: 'sum', fileId: '1', etag: 'new-etag', creationTime: ctime, lastModified: mtime };
const response = (status: number, text: string) => ({ status, text, json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
const multistatus = (status: number) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/note.md</d:href><d:propstat><d:prop><d:creationdate/></d:prop><d:status>HTTP/1.1 ${status} Result</d:status></d:propstat></d:response></d:multistatus>`;

beforeEach(() => mock.mockReset());
test('metadata-only update is guarded and checks the persisted values after a successful multistatus', async () => {
  const client = new NextcloudClient(settings, 'pw', 'Vault');
  jest.spyOn(client, 'statFile').mockResolvedValue(remote);
  mock.mockResolvedValue(response(207, multistatus(200)));
  await expect(client.setFileTimes('note.md', { ctime, mtime }, 'old-etag')).resolves.toEqual(remote);
  const req = mock.mock.calls[0][0];
  expect(req.method).toBe('PROPPATCH');
  expect(req.headers['If-Match']).toBe('"old-etag"');
  expect(req.body).toContain('<d:creationdate>2019-12-31T16:00:00.000Z</d:creationdate>');
  expect(req.body).toContain('<d:lastmodified>1646092800</d:lastmodified>');
  expect(req.body).toMatch(/<d:getetag>[a-f0-9]{32}<\/d:getetag>/);
});
test('a partial property failure never counts as a successful timestamp update', async () => {
  const client = new NextcloudClient(settings, 'pw', 'Vault');
  const stat = jest.spyOn(client, 'statFile');
  mock.mockResolvedValue(response(207, multistatus(403)));
  await expect(client.setFileTimes('note.md', { ctime, mtime }, 'old-etag')).rejects.toThrow();
  expect(stat).not.toHaveBeenCalled();
});
test('a concurrent write and a server silently ignoring timestamps are rejected', async () => {
  const client = new NextcloudClient(settings, 'pw', 'Vault');
  mock.mockResolvedValueOnce(response(412, 'Precondition Failed'));
  await expect(client.setFileTimes('note.md', { ctime }, 'old-etag')).rejects.toBeInstanceOf(PreconditionFailedError);
  mock.mockResolvedValue(response(207, multistatus(200)));
  jest.spyOn(client, 'statFile').mockResolvedValue({ ...remote, creationTime: ctime + 1000 });
  await expect(client.setFileTimes('note.md', { ctime }, 'old-etag')).rejects.toThrow('did not preserve');
});
