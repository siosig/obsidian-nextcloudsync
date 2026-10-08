import { requestUrl } from 'obsidian';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { DEFAULT_SETTINGS, DavSyncSettings, RemoteRootMissingError } from '../../../src/types';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'device-abcd1234',
};

const res = (status: number, headers: Record<string, string> = {}) =>
  Promise.resolve({ status, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers });

const client = () => new NextcloudClient(settings, 'pw', 'Vault');

// [SPEC:NET-3] NextcloudClient.reqReadonly() retries a transient req() rejection (timeout / connection failure)
// up to 2x, only for read-only PROPFIND/GET. req() rejects only when no HTTP response arrived (any status resolves),
// so a rejection here is always transient. Writes never retry: a timed-out write may already have succeeded
// server-side. REPORT-based getChanges()/getSyncToken() are out of scope (the full-scan PROPFIND fallback covers them).
describe('NextcloudClient — read-only retry on transient req() rejection (feature 067)', () => {
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

  it('getFiles (PROPFIND) retries once after a transient rejection, then surfaces the root 404 as RemoteRootMissingError', async () => {
    // The retry itself is unchanged: a rejection is transient, so the second attempt happens. A 404 on the vault root
    // is not flattened into an empty listing: "folder gone" and "folder empty" drive opposite engine behaviour
    // (see vaultRootListing.test.ts).
    let calls = 0;
    mockRequestUrl.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('timeout'));
      return res(404); // resolved -> the retry reached the server, which says the base folder is missing
    });

    const promise = client().getFiles('');
    promise.catch(() => undefined);

    await jest.advanceTimersByTimeAsync(1000);

    await expect(promise).rejects.toThrow(RemoteRootMissingError);
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });

  it('statFile (PROPFIND) exhausts retries (3 total attempts) and rethrows the original error', async () => {
    mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

    const promise = client().statFile('Notes/a.md');
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

  // Scope boundary: getChanges()/getSyncToken() ride REPORT and are not retried (only PROPFIND/GET are);
  // both must fail immediately on a transient rejection, same as a write.
  it('getChanges (REPORT) does NOT retry on a transient rejection — fails after exactly 1 call', async () => {
    mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

    await expect(client().getChanges('sync-token-1')).rejects.toThrow('timeout');
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  // getSyncToken performs no request (issue #37): Nextcloud's files DAV cannot answer a sync-collection REPORT. Covered by SCR-1.
  it('getSyncToken issues no request at all, so retry behaviour does not apply', async () => {
    mockRequestUrl.mockImplementation(() => Promise.reject(new Error('timeout')));

    await expect(client().getSyncToken()).resolves.toBeNull();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });
});
