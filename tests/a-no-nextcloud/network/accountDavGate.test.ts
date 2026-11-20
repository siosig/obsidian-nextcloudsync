import { requestUrl } from 'obsidian';
import { DOMParser } from '@xmldom/xmldom';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, FeatureUnsupportedError } from '../../../src/types';

// Parsing the versions PROPFIND needs a DOMParser, which the a-layer node environment lacks.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const VERSION = { versionId: '1', href: '', lastModified: 0, size: 0 };

function publicShareClient(): NextcloudClient {
  return new NextcloudClient(
    { ...DEFAULT_SETTINGS, serverUrl: 'https://cloud.example.com/public.php/webdav/', username: 'TOKEN' },
    () => 'pw',
    'Vault',
  );
}

describe('[SPEC:SD-6] a public link share never reaches the account-only DAV namespaces', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  it('listVersions is refused before any request leaves', async () => {
    const p = publicShareClient().listVersions('42');
    await expect(p).rejects.toBeInstanceOf(FeatureUnsupportedError);
    await expect(p).rejects.toMatchObject({ feature: 'versions' });
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('getVersionContent is refused before any request leaves', async () => {
    const p = publicShareClient().getVersionContent(VERSION, '42');
    await expect(p).rejects.toBeInstanceOf(FeatureUnsupportedError);
    await expect(p).rejects.toMatchObject({ feature: 'versions' });
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('restoreVersion is refused before any request leaves', async () => {
    const p = publicShareClient().restoreVersion(VERSION, '42');
    await expect(p).rejects.toBeInstanceOf(FeatureUnsupportedError);
    await expect(p).rejects.toMatchObject({ feature: 'versions' });
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('uploadChunked is refused before any request leaves', async () => {
    const p = publicShareClient().uploadChunked('big.bin', new ArrayBuffer(1), 1);
    await expect(p).rejects.toBeInstanceOf(FeatureUnsupportedError);
    await expect(p).rejects.toMatchObject({ feature: 'chunked-upload' });
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('the guard does not block an account URL', async () => {
    const client = new NextcloudClient(
      { ...DEFAULT_SETTINGS, serverUrl: 'https://cloud.example.com/remote.php/dav/files/alice/', username: 'alice' },
      () => 'pw',
      'Vault',
    );
    mockRequestUrl.mockResolvedValue({
      status: 207, text: '<d:multistatus xmlns:d="DAV:"></d:multistatus>', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {},
    });
    await client.listVersions('42');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    expect(mockRequestUrl.mock.calls[0][0]).toMatchObject({
      method: 'PROPFIND',
      url: 'https://cloud.example.com/remote.php/dav/versions/alice/versions/42',
    });
  });
});
