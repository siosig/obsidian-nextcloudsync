import { requestUrl } from 'obsidian';
import { ChunkedUploadStrategy } from '../../../src/sync/upload/ChunkedUploadStrategy';
import { UploadConfig } from '../../../src/sync/upload/IUploadStrategy';
import { IWebDAVClient } from '../../../src/network/IWebDAVClient';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, DavSyncSettings, PreconditionFailedError } from '../../../src/types';

// G5-1: the chunked-upload MAIN path must carry the optimistic-concurrency `opts`
// (ifMatchEtag) exactly like the single-PUT path, so a large file is not silently
// overwritten when the remote changed concurrently.

interface FakeClient {
  uploadFile: jest.Mock;
  uploadChunked: jest.Mock;
}

function fakeClient(): FakeClient {
  return {
    uploadFile: jest.fn().mockResolvedValue(undefined),
    uploadChunked: jest.fn().mockResolvedValue(undefined),
  };
}

function uploadConfig(over: Partial<UploadConfig>): UploadConfig {
  return { maxFileSizeMB: 0, uploadChunkThresholdMB: 0.0000001, ...over };
}

const data = new ArrayBuffer(10);

describe('G5-1: ChunkedUploadStrategy forwards ifMatchEtag to uploadChunked (large-file path)', () => {
  it('passes opts (including ifMatchEtag) through on the main chunked-upload call', async () => {
    const client = fakeClient();
    const s = new ChunkedUploadStrategy(uploadConfig({ maxFileSizeMB: 100 }));
    const outcome = await s.upload(
      client as unknown as IWebDAVClient, 'big.bin', data, 1000, { ifMatchEtag: 'remote-etag' },
    );
    expect(outcome).toBe('uploaded');
    expect(client.uploadChunked).toHaveBeenCalledTimes(1);
    const [, , , forwardedOpts] = client.uploadChunked.mock.calls[0];
    expect(forwardedOpts).toEqual({ ifMatchEtag: 'remote-etag' });
  });
});

describe('G5-1: NextcloudClient.uploadChunked — assembling MOVE carries If-Match', () => {
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

  beforeEach(() => mockRequestUrl.mockReset());

  it('sends If-Match on the assembling MOVE and maps 412 to PreconditionFailedError', async () => {
    mockRequestUrl.mockImplementation((req) => {
      if (req.method === 'MOVE') return res(412);
      return res(201); // MKCOL, chunk PUT, and the abort-cleanup DELETE all succeed
    });
    await expect(
      new NextcloudClient(settings, 'pw', 'Vault').uploadChunked('Notes/big.bin', new ArrayBuffer(2), 10 * 1024 * 1024, { ifMatchEtag: 'etag-xyz' }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    const move = calls('MOVE')[0];
    expect(move.headers?.['If-Match']).toBe('"etag-xyz"');
  });

  it('does not send If-Match when ifMatchEtag is absent (unchanged behavior)', async () => {
    // Everything succeeds (201); the final PROPFIND checksum-verify step gets a non-207 status
    // (also 201 here) so it short-circuits without a mismatch — see verifyRemoteChecksum().
    mockRequestUrl.mockImplementation(() => res(201));
    await new NextcloudClient(settings, 'pw', 'Vault').uploadChunked('Notes/big.bin', new ArrayBuffer(2), 10 * 1024 * 1024);
    const move = calls('MOVE')[0];
    expect(move.headers?.['If-Match']).toBeUndefined();
  });
});
