import { ChunkedUploadStrategy } from '../../src/sync/upload/ChunkedUploadStrategy';
import { DEFAULT_SETTINGS, DavSyncSettings, NetworkError } from '../../src/types';
import { IWebDAVClient } from '../../src/network/IWebDAVClient';

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

function settings(over: Partial<DavSyncSettings>): DavSyncSettings {
  return { ...DEFAULT_SETTINGS, ...over };
}

const data = new ArrayBuffer(10); // 約 9.5e-6 MB

describe('ChunkedUploadStrategy', () => {
  it('skips files larger than maxFileSizeMB', async () => {
    const client = fakeClient();
    const s = new ChunkedUploadStrategy(settings({ maxFileSizeMB: 0.0000001 }));
    const outcome = await s.upload(client as unknown as IWebDAVClient, 'big.bin', data);
    expect(outcome).toBe('skipped');
    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(client.uploadChunked).not.toHaveBeenCalled();
  });

  it('uses chunked upload above the chunk threshold', async () => {
    const client = fakeClient();
    const s = new ChunkedUploadStrategy(settings({ uploadChunkThresholdMB: 0.0000001, maxFileSizeMB: 100 }));
    const outcome = await s.upload(client as unknown as IWebDAVClient, 'mid.bin', data);
    expect(outcome).toBe('uploaded');
    expect(client.uploadChunked).toHaveBeenCalledTimes(1);
    expect(client.uploadFile).not.toHaveBeenCalled();
  });

  it('uses a single PUT below the chunk threshold', async () => {
    const client = fakeClient();
    const s = new ChunkedUploadStrategy(settings({ uploadChunkThresholdMB: 100, maxFileSizeMB: 1000 }));
    const outcome = await s.upload(client as unknown as IWebDAVClient, 'small.md', data);
    expect(outcome).toBe('uploaded');
    expect(client.uploadFile).toHaveBeenCalledTimes(1);
    expect(client.uploadChunked).not.toHaveBeenCalled();
  });

  it('falls back to single PUT when chunked upload fails', async () => {
    const client = fakeClient();
    client.uploadChunked.mockRejectedValueOnce(new NetworkError(500, 'boom'));
    const s = new ChunkedUploadStrategy(settings({ uploadChunkThresholdMB: 0.0000001, maxFileSizeMB: 100 }));
    const outcome = await s.upload(client as unknown as IWebDAVClient, 'mid.bin', data);
    expect(outcome).toBe('uploaded');
    expect(client.uploadChunked).toHaveBeenCalledTimes(1);
    expect(client.uploadFile).toHaveBeenCalledTimes(1);
  });
});
