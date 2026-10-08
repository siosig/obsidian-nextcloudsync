import { requestUrl } from 'obsidian';
import { ensureRemoteDir } from '../../../src/network/remotePath';
import { RemoteDirCache } from '../../../src/network/RemoteDirCache';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { IWebDAVClient } from '../../../src/network/IWebDAVClient';
import { DEFAULT_SETTINGS, DavSyncSettings, NetworkError, RemoteDirCreateError } from '../../../src/types';

// The "create missing parent collections" path: a failed MKCOL must not be cached as created, and
// StandardWebDAVClient must drop stale positives before re-issuing MKCOLs (as NextcloudClient does).
// The fake server models: PUT/MOVE into a missing parent is 404, MKCOL under a missing parent is 409.
// The single-flight cache itself is covered by remoteDirCache.test.ts.

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const BASE = 'https://nc/remote.php/dav/files/alice';

const settings: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: `${BASE}/`,
  username: 'alice',
  // 0 = unbounded: keeps requestUrlWithTimeout from arming a real timer in the test process.
  networkTimeoutSeconds: 0,
};

const ctx = { baseUrl: BASE, authHeader: 'Basic redacted', timeoutMs: 0 };

const DATA = new ArrayBuffer(4);

interface FakeResponse {
  status: number;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
}

const res = (status: number, text = ''): Promise<FakeResponse> =>
  Promise.resolve({ status, text, json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });

interface FakeRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

function pathOf(url: string): string {
  const raw = url.startsWith(`${BASE}/`) ? url.slice(BASE.length + 1) : url;
  return raw.split('/').map(decodeURIComponent).join('/');
}

function parentOf(remotePath: string): string {
  return remotePath.split('/').slice(0, -1).join('/');
}

function log(): { method: string; path: string }[] {
  return mockRequestUrl.mock.calls.map((c) => {
    const req = c[0] as FakeRequest;
    return { method: req.method ?? 'GET', path: pathOf(req.url) };
  });
}

const trace = (): string[] => log().map((e) => `${e.method} ${e.path}`);
const mkcolPaths = (): string[] => log().filter((e) => e.method === 'MKCOL').map((e) => e.path);
const countOf = (method: string, path: string): number =>
  log().filter((e) => e.method === method && e.path === path).length;

// Minimal WebDAV server: '' (the files root) always exists; MKCOL under a missing parent is 409,
// MKCOL of an existing collection is 405, PUT/MOVE with a missing parent is 404 (as Nextcloud returns).
function fakeServer() {
  const dirs = new Set<string>(['']);
  const files = new Set<string>();

  const handle = (req: FakeRequest): Promise<FakeResponse> => {
    const path = pathOf(req.url);
    const parent = parentOf(path);
    switch (req.method) {
      case 'MKCOL':
        if (!dirs.has(parent)) return res(409, 'Sabre\\DAV\\Exception\\Conflict');
        if (dirs.has(path)) return res(405);
        dirs.add(path);
        return res(201);
      case 'PUT':
        if (!dirs.has(parent)) return res(404);
        files.add(path);
        return res(201);
      case 'MOVE': {
        const dest = pathOf(String(req.headers?.Destination ?? ''));
        if (!files.has(path)) return res(404);
        if (!dirs.has(parentOf(dest))) return res(404);
        files.delete(path);
        files.add(dest);
        return res(201);
      }
      default:
        return res(200);
    }
  };

  return {
    dirs,
    files,
    install(): void {
      mockRequestUrl.mockImplementation(handle);
    },
    // Another device removed a collection this client had already created.
    removeDir(path: string): void {
      dirs.delete(path);
      for (const f of [...files]) if (f.startsWith(`${path}/`)) files.delete(f);
    },
  };
}

const nextcloud = (): IWebDAVClient => new NextcloudClient(settings, 'pw', 'Vault');
const standard = (): IWebDAVClient => new StandardWebDAVClient(settings, 'pw', 'Vault');

beforeEach(() => {
  mockRequestUrl.mockReset();
});

// ensureRemoteDir

describe('ensureRemoteDir — exactly one MKCOL per uncreated level ([SPEC:MSF-6] [SPEC:MSF-7])', () => {
  it('[SPEC:MSF-6]: issues one MKCOL per uncreated level, and none for a level already proven', async () => {
    const server = fakeServer();
    server.install();
    const cache = new RemoteDirCache();

    await ensureRemoteDir(ctx, 'Vault/F/x/y/note.md', cache);
    expect(mkcolPaths()).toEqual(['Vault', 'Vault/F', 'Vault/F/x', 'Vault/F/x/y']);

    // A second file under an already-proven branch adds MKCOLs only for what is genuinely new.
    mockRequestUrl.mockClear();
    await ensureRemoteDir(ctx, 'Vault/F/x/other/deep.md', cache);
    expect(mkcolPaths()).toEqual(['Vault/F/x/other']);

    // And a file whose whole ancestry is proven issues nothing at all.
    mockRequestUrl.mockClear();
    await ensureRemoteDir(ctx, 'Vault/F/x/y/second.md', cache);
    expect(mkcolPaths()).toEqual([]);
  });

  it('[SPEC:MSF-6]: a file directly under the request root has no ancestors and issues no MKCOL', async () => {
    fakeServer().install();
    await ensureRemoteDir(ctx, 'note.md', new RemoteDirCache());
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });

  it('[SPEC:MSF-7]: stops at the level whose MKCOL failed and never descends below it', async () => {
    // 'Vault' is created normally; every level below it is refused with a 423 (the file lock
    // Nextcloud returns for a concurrent MKCOL of the same collection).
    mockRequestUrl.mockImplementation((req: FakeRequest) => {
      const path = pathOf(req.url);
      if (req.method !== 'MKCOL') return res(200);
      return path === 'Vault' ? res(201) : res(423, 'OCA\\DAV\\Connector\\Sabre\\Exception\\FileLocked');
    });

    const error = await ensureRemoteDir(ctx, 'Vault/F/x/y/note.md', new RemoteDirCache())
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteDirCreateError);
    const failure = error as RemoteDirCreateError;
    expect(failure.dirPath).toBe('Vault/F');
    expect(failure.status).toBe(423);
    // The whole point of MSF-7: no MKCOL for 'Vault/F/x' or below, because their parent is missing.
    expect(mkcolPaths()).toEqual(['Vault', 'Vault/F']);
  });

  it('[SPEC:MSF-6] [SPEC:MSF-7]: a failed level is not remembered — the next call retries it, proven levels stay', async () => {
    let failNext = true;
    mockRequestUrl.mockImplementation((req: FakeRequest) => {
      const path = pathOf(req.url);
      if (req.method !== 'MKCOL') return res(200);
      if (path === 'Vault') return res(201);
      if (path === 'Vault/F' && failNext) {
        failNext = false;
        return res(423);
      }
      return res(201);
    });

    await expect(ensureRemoteDir(ctx, 'Vault/F/note.md', new RemoteDirCache()))
      .rejects.toBeInstanceOf(RemoteDirCreateError);

    // Same cache instance would be enough; a fresh one is not the point — the point is that the
    // failure was NOT cached as "created", so the level is attempted again and now succeeds.
    const cache = new RemoteDirCache();
    await ensureRemoteDir(ctx, 'Vault/F/note.md', cache);
    mockRequestUrl.mockClear();
    await ensureRemoteDir(ctx, 'Vault/F/second.md', cache);
    expect(mkcolPaths()).toEqual([]); // both levels are now proven
  });
});

describe('ensureRemoteDir — concurrent branches share their common ancestors ([SPEC:MSF-6] [SPEC:MSF-10])', () => {
  it('[SPEC:MSF-6] [SPEC:MSF-10]: F/x/y and F/x/z in flight together issue one MKCOL for F and one for F/x', async () => {
    const dirs = new Set<string>(['']);
    // Resolve on a later macrotask so the two chains genuinely overlap: without single-flight both
    // reach the "not in cache" branch for 'Vault/F' before either MKCOL has come back.
    mockRequestUrl.mockImplementation(async (req: FakeRequest) => {
      const path = pathOf(req.url);
      await new Promise((r) => setTimeout(r, 0));
      if (req.method !== 'MKCOL') return res(200);
      if (!dirs.has(parentOf(path))) return res(409);
      if (dirs.has(path)) return res(405);
      dirs.add(path);
      return res(201);
    });

    const cache = new RemoteDirCache();
    await Promise.all([
      ensureRemoteDir(ctx, 'Vault/F/x/y/a.md', cache),
      ensureRemoteDir(ctx, 'Vault/F/x/z/b.md', cache),
    ]);

    expect(countOf('MKCOL', 'Vault')).toBe(1);
    expect(countOf('MKCOL', 'Vault/F')).toBe(1);
    expect(countOf('MKCOL', 'Vault/F/x')).toBe(1);
    expect(countOf('MKCOL', 'Vault/F/x/y')).toBe(1);
    expect(countOf('MKCOL', 'Vault/F/x/z')).toBe(1);
    expect(mkcolPaths()).toHaveLength(5);
  });
});

// Recovery from a missing parent: identical in both clients

describe.each([
  ['NextcloudClient', nextcloud],
  ['StandardWebDAVClient', standard],
])('%s — missing-parent recovery (MSF-8 MSF-10 MSF-11)', (_name, makeClient) => {
  it('[SPEC:MSF-11] [SPEC:MSF-10]: uploadFile recovers from a stale positive — PUT 404, ancestors forgotten, MKCOL re-issued, retry PUT succeeds', async () => {
    const server = fakeServer();
    server.install();
    const client = makeClient();

    // Seed: this upload really creates 'Vault' and 'Vault/F', so both are now cached as created.
    await client.uploadFile('F/a.md', DATA);
    expect(server.files.has('Vault/F/a.md')).toBe(true);

    // Another device deletes the folder. The cache still claims it exists — the stale positive.
    server.removeDir('Vault/F');
    mockRequestUrl.mockClear();

    await expect(client.uploadFile('F/b.md', DATA)).resolves.toBeUndefined();

    // Order: PUT (404) -> MKCOL of the forgotten ancestors -> exactly one retry PUT.
    const t = trace();
    expect(t[0]).toBe('PUT Vault/F/b.md');
    expect(t[t.length - 1]).toBe('PUT Vault/F/b.md');
    expect(t.slice(1, -1)).toContain('MKCOL Vault/F');
    expect(countOf('PUT', 'Vault/F/b.md')).toBe(2); // retried once, never twice
    expect(countOf('MKCOL', 'Vault/F')).toBe(1);
    expect(server.files.has('Vault/F/b.md')).toBe(true);
  });

  it('[SPEC:MSF-11] [SPEC:MSF-10]: moveFile recovers from a stale positive on the destination parent', async () => {
    const server = fakeServer();
    server.install();
    const client = makeClient();

    await client.uploadFile('src.md', DATA); // creates 'Vault', the MOVE source
    await client.uploadFile('F/seed.md', DATA); // creates 'Vault/F', the MOVE destination parent
    server.removeDir('Vault/F');
    mockRequestUrl.mockClear();

    await expect(client.moveFile('src.md', 'F/moved.md')).resolves.toBeUndefined();

    const t = trace();
    expect(t[t.length - 1]).toBe('MOVE Vault/src.md');
    expect(countOf('MOVE', 'Vault/src.md')).toBe(2); // the 404 and the single retry
    expect(mkcolPaths()).toContain('Vault/F');
    expect(server.files.has('Vault/F/moved.md')).toBe(true);
  });

  it('[SPEC:MSF-8]: an ancestor MKCOL that fails 403 stays invisible while the retry PUT succeeds', async () => {
    // The collection is really there but the account may not MKCOL it; the ancestor failure must not become a user-visible error.
    let puts = 0;
    mockRequestUrl.mockImplementation((req: FakeRequest) => {
      if (req.method === 'MKCOL') return res(403, 'Forbidden');
      if (req.method === 'PUT') {
        puts += 1;
        return puts === 1 ? res(404) : res(201);
      }
      return res(200);
    });

    await expect(makeClient().uploadFile('F/note.md', DATA)).resolves.toBeUndefined();
    expect(puts).toBe(2);
    expect(mkcolPaths()[0]).toBe('Vault'); // it did try, and stopped at the first refusal (MSF-7)
  });

  it('[SPEC:MSF-8] [SPEC:MSF-7]: when the retry PUT fails too, the error names the failing level and its MKCOL status', async () => {
    // Replaces the undiagnosable "HTTP 404 (PUT)" with the level that could not be created.
    mockRequestUrl.mockImplementation((req: FakeRequest) => {
      const path = pathOf(req.url);
      if (req.method === 'MKCOL') return path === 'Vault' ? res(405) : res(423, 'FileLocked');
      if (req.method === 'PUT') return res(404);
      return res(200);
    });

    const error = await makeClient().uploadFile('F/sub/note.md', DATA)
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteDirCreateError);
    expect(error).toBeInstanceOf(NetworkError); // rides the existing per-file network-error handling
    const failure = error as RemoteDirCreateError;
    expect(failure.dirPath).toBe('Vault/F'); // the LEVEL that failed, not the file
    expect(failure.status).toBe(423);
    expect(failure.message).toContain('Vault/F');
    expect(failure.message).toContain('423');
    expect(failure.message).not.toContain('\n'); // one line
    expect(failure.message).not.toContain('Basic'); // never leaks the Authorization header
    expect(mkcolPaths()).not.toContain('Vault/F/sub'); // MSF-7: no descent past the failure
    expect(countOf('PUT', 'Vault/F/sub/note.md')).toBe(2); // the retry still happened, exactly once
  });
});

// Callers that do not want the parent-recovery treatment

describe.each([
  ['NextcloudClient', nextcloud],
  ['StandardWebDAVClient', standard],
])('%s — createDirectory reports, createVaultRoot decides (MSF-9)', (_name, makeClient) => {
  it('[SPEC:MSF-9]: createDirectory fails when the collection could not be created', async () => {
    // A MKCOL failure must be reported, not swallowed: watch mode marks the folder tracked as soon as this
    // returns, so a silent failure would track a folder the server lacks (issue #46).
    mockRequestUrl.mockImplementation((req: FakeRequest) =>
      req.method === 'MKCOL' ? res(423, 'FileLocked') : res(200));

    const error = await makeClient().createDirectory('F').then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteDirCreateError);
    expect((error as RemoteDirCreateError).status).toBe(423);
  });

  it('[SPEC:MSF-9]: createDirectory resolves when the collection already exists', async () => {
    const server = fakeServer();
    server.install();
    await makeClient().createDirectory('F');
    expect(server.dirs.has('Vault/F')).toBe(true);
    await expect(makeClient().createDirectory('F')).resolves.toBeUndefined(); // 405 is not a failure
  });

  it('[SPEC:MSF-9]: createVaultRoot still answers even when an ancestor MKCOL fails', async () => {
    // Ancestors are explicitly not the question: the strict MKCOL of the vault folder decides whether the caller
    // may reset tracking and re-seed, so a transient 423 on a level above it must not take that answer away.
    // A nested remote base gives the vault folder an ancestor; with a single-segment base there is nothing to attempt.
    const nested = _name === 'NextcloudClient'
      ? new NextcloudClient(settings, 'pw', 'Docs/Vault')
      : new StandardWebDAVClient(settings, 'pw', 'Docs/Vault');
    let vaultMkcols = 0;
    mockRequestUrl.mockImplementation((req: FakeRequest) => {
      if (req.method !== 'MKCOL') return res(200);
      if (pathOf(req.url) !== 'Docs/Vault') return res(423, 'FileLocked'); // the ancestor 'Docs'
      vaultMkcols++;
      return res(201); // the vault folder was genuinely absent
    });

    await expect(nested.createVaultRoot()).resolves.toBe('created');
    expect(vaultMkcols).toBe(1);
    expect(mkcolPaths()).toContain('Docs'); // the ancestor really was attempted, and really failed
  });
});

// A failure that is not about the parent must be reported as itself

describe.each([
  ['NextcloudClient', nextcloud],
  ['StandardWebDAVClient', standard],
])('%s — only a missing-parent answer may override the write\'s own status (MSF-8)', (_name, makeClient) => {
  it('[SPEC:MSF-8]: a MOVE that fails for an unrelated reason keeps its own status', async () => {
    // A share the user can write to but not MKCOL in: every MKCOL is 403 while the folder is real. A move
    // failure there must be reported as itself, not as "could not create the remote folder".
    mockRequestUrl.mockImplementation((req: FakeRequest) => {
      if (req.method === 'MKCOL') return res(403, 'Forbidden');
      if (req.method === 'MOVE') return res(423, 'FileLocked'); // nothing to do with the parent
      return res(200);
    });

    const error = await makeClient().moveFile('a.md', 'F/b.md').then(() => null, (e: unknown) => e);

    expect(error).not.toBeInstanceOf(RemoteDirCreateError);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).status).toBe(423); // the MOVE's status, not the MKCOL's
  });

  it('[SPEC:MSF-8]: a MKCOL that never got an answer does not buy a second network timeout', async () => {
    // A rejected request means no answer at all, so the parent is certainly still missing and the
    // retry can only be told the same 404 — after burning another full timeout. One write, not two.
    let puts = 0;
    mockRequestUrl.mockImplementation((req: FakeRequest) => {
      if (req.method === 'MKCOL') return Promise.reject(new Error('network timeout'));
      if (req.method === 'PUT') { puts++; return res(404); }
      return res(200);
    });

    const error = await makeClient().uploadFile('F/note.md', DATA).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteDirCreateError);
    expect((error as RemoteDirCreateError).status).toBe(0); // 0 = the request itself failed
    expect((error as RemoteDirCreateError).message).toContain('network timeout');
    expect(puts).toBe(1); // the first PUT only — no retry
  });
});
