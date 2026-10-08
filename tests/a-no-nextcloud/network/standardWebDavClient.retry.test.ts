import { requestUrl } from 'obsidian';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { DEFAULT_SETTINGS, DavSyncSettings } from '../../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'device-abcd1234',
};

const res = (status: number, headers: Record<string, string> = {}) =>
  Promise.resolve({ status, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers });

const client = () => new StandardWebDAVClient(settings, 'pw', 'Vault');

// [SPEC:NET-3] StandardWebDAVClient.reqReadonly() retries a transient req() rejection (timeout / connection failure)
// up to 2x for read-only PROPFIND/GET only. Writes (PUT/DELETE/MOVE) never retry: a timed-out write may have already
// succeeded server-side. Same clause as nextcloudClient.retry.test.ts: one clause, two client implementations.
describe('StandardWebDAVClient — read-only retry on transient req() rejection (feature 067)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRequestUrl.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('statFile (PROPFIND) retries once after a transient rejection and returns success', async () => {
    let calls = 0;
    mockRequestUrl.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('timeout'));
      return res(404); // resolved (not rejected) — statFile treats 404 as "not found" -> null
    });

    const promise = client().statFile('Notes/a.md');
    promise.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(1000); // first backoff delay elapses -> retry fires

    await expect(promise).resolves.toBeNull();
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('connect (PROPFIND) exhausts retries (3 total attempts) and rethrows the original error', async () => {
    mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

    const promise = client().connect();
    promise.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(1000); // 1st backoff -> retry #1
    await jest.advanceTimersByTimeAsync(2000); // 2nd backoff -> retry #2

    await expect(promise).rejects.toThrow('timeout');
    expect(mockRequestUrl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('downloadFile (GET) retries once after a transient rejection and returns success', async () => {
    let calls = 0;
    mockRequestUrl.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('timeout'));
      return res(200);
    });

    const promise = client().downloadFile('Notes/a.md');
    promise.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBeInstanceOf(ArrayBuffer);
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('uploadFile (PUT) does NOT retry on a transient rejection — fails after exactly 1 call', async () => {
    mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

    await expect(client().uploadFile('Notes/a.md', new ArrayBuffer(2))).rejects.toThrow('timeout');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it('deleteFile (DELETE) does NOT retry on a transient rejection — fails after exactly 1 call', async () => {
    mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

    await expect(client().deleteFile('Notes/a.md', 'rid')).rejects.toThrow('timeout');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it('moveFile (MOVE) does NOT retry on a transient rejection — fails after exactly 1 call', async () => {
    // moveFile MKCOLs the destination's ancestors before the MOVE; make every call reject. That ancestor step is
    // advisory (a failure does not abort the MOVE), so this pins only that the MOVE is attempted exactly ONCE.
    mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

    await expect(client().moveFile('a.md', 'b.md')).rejects.toThrow('timeout');
    const moves = mockRequestUrl.mock.calls.filter((c) => (c[0] as { method?: string }).method === 'MOVE');
    expect(moves).toHaveLength(1);
  });

  it('statFile (PROPFIND) does NOT retry on a resolved non-transient 404 status', async () => {
    mockRequestUrl.mockImplementation(() => res(404));

    await expect(client().statFile('Notes/missing.md')).resolves.toBeNull();
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });
});
