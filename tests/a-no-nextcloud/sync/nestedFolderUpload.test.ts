// MSF-12 MSF-13 MSF-14 MSF-15 MSF-16 — specs/088-mkcol-single-flight/spec.md, User Story 1.
//
// The bug this file pins down is not in the engine and not in any single request: it is what happens
// when two uploads that share an ANCESTOR run at the same time.
//
// Uploads are serialised per *immediate parent directory* (`runFileBatch(..., serializeByDir=true)`,
// SyncEngine.ts:1079ff). `F/a.md` sits under `F` and `F/sub/b.md` under `F/sub`, so they land on two
// different promise chains and run in parallel — while both need the same ancestor `F` to exist.
// Neither chain knows about the other's MKCOL, so both issue it, and `ensureRemoteDir` then records
// the path as "created" WITHOUT looking at the status the server returned. One lie is enough: every
// later request in that session skips the MKCOL it now believes is unnecessary.
//
// That is why one nesting level is stable and two are not — `F/a.md` + `F/b.md` share a chain and
// never race (MSF-15 asserts that half stays working), whereas `F/a.md` + `F/sub/b.md` failed about
// one run in four on the live b-1 instance.
//
// ── Why the fake server answers the way it does ──────────────────────────────────────────────────
// These tests drive the REAL `NextcloudClient` (so the real `ensureRemoteDir` + `createdDirs` cache
// are under test) against an in-memory WebDAV server behind the `requestUrl` mock. The three answers
// that matter were MEASURED against the b-1 instance (Nextcloud 34) on 2026-09-10 with raw HTTP, no
// client cache involved — see "実サーバーでの確認" in the spec:
//
//   - concurrent MKCOL on the SAME collection → first 201, the others 423 Locked
//     (`OCA\DAV\Connector\Sabre\Exception\FileLocked`); observed [201,423,405,423] and
//     [405,423,201,405,405,405,405,405]
//   - MKCOL whose parent does not exist yet    → 409 Conflict (`Sabre\DAV\Exception\Conflict`)
//   - PUT whose parent does not exist yet      → 404 (Nextcloud's files DAV, not the RFC's 409)
//
// The 423 is the whole point. Without it a fake server would happily accept both concurrent MKCOLs
// and the race would be invisible here while remaining real in production. So the server below
// refuses a MKCOL that arrives while another MKCOL for the same path is still in flight, and holds a
// genuine creation open for a few macrotasks so the overlap is deterministic rather than lucky.
//
// After the fix the same server produces exactly one MKCOL per path: the single-flight cache makes
// the second caller await the first one's request instead of issuing its own, so 423 never occurs.
import { DataAdapter, requestUrl } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, DavSyncSettings, NextcloudFeatures } from '../../../src/types';
import { TFile, TFolder } from '../support/obsidian';

const mockRequestUrl = requestUrl as unknown as jest.Mock;

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;

const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';
/** Fixed local mtime, far outside the signature safety window of both `now` and the last sync. */
const MTIME = 1_000;

const SETTINGS: DavSyncSettings = {
  ...DEFAULT_SETTINGS,
  serverUrl: 'https://nc/remote.php/dav/files/alice/',
  username: 'alice',
  deviceId: 'device-abcd1234',
  syncOnWifiOnly: false,
};

/** Request URL prefix the settings above produce (the Server URL minus its trailing slash). */
const URL_BASE = 'https://nc/remote.php/dav/files/alice';
/** The remote base folder (the vault name). Every remote path below is rooted here. */
const BASE = 'Vault';
/** The path prefix of every href the fake server emits. */
const HREF_ROOT = '/remote.php/dav/files/alice';

/**
 * How many macrotasks a genuine MKCOL creation is held open.
 *
 * Every other answer resolves on a microtask, so a chain that receives 423/409/404 runs its whole
 * remaining reactive-recovery sequence (MKCOL the child, retry the PUT) while the winning MKCOL is
 * still in flight — which is exactly the live trace `a: mkcol=[423] → retry PUT 404`,
 * `b: mkcol=[423, 409] → retry PUT 404`. Making the two orders of magnitude apart is what turns a
 * timing-dependent production race into a deterministic test.
 */
const CREATE_MACROTASKS = 5;

const LOCKED_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">'
  + '<s:exception>OCA\\DAV\\Connector\\Sabre\\Exception\\FileLocked</s:exception>'
  + '<s:message>"Vault" is locked</s:message></d:error>';
const CONFLICT_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">'
  + '<s:exception>Sabre\\DAV\\Exception\\Conflict</s:exception>'
  + '<s:message>Parent node does not exist</s:message></d:error>';

interface FakeResponse {
  status: number;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
}

const reply = (status: number, text = '', arrayBuffer: ArrayBuffer = new ArrayBuffer(0)): FakeResponse =>
  ({ status, text, json: {}, arrayBuffer, headers: {} });

/** One macrotask. `window` is aliased onto the Node global by tests/a-no-nextcloud/support/setup.ts. */
const macrotask = (): Promise<void> => new Promise((r) => { window.setTimeout(r, 0); });

async function afterMacrotasks<T>(n: number, value: () => T): Promise<T> {
  for (let i = 0; i < n; i++) await macrotask();
  return value();
}

interface RemoteFile { body: string; checksum: string | null; mtime: number }
interface RequestRecord { method: string; path: string; status: number }

interface ServerOptions {
  /**
   * When set, a MKCOL that would CREATE a collection answers with this status instead (a server that
   * permanently refuses to create anything). A MKCOL on a collection that already exists still
   * answers 405, because that is not a creation.
   */
  mkcolCreateStatus?: number;
}

/**
 * A small in-memory Nextcloud, driven through the `requestUrl` mock.
 *
 * It models only what this feature turns on: which collections exist, that a PUT into a missing
 * collection 404s, and that MKCOL is not safe to issue twice concurrently. Everything else is the
 * minimum the engine's full-scan path needs to reach the upload stage.
 */
function makeServer(opts: ServerOptions = {}) {
  const dirs = new Set<string>([BASE]);
  const files = new Map<string, RemoteFile>();
  /** Collections whose MKCOL has been accepted but not yet completed — the source of the 423. */
  const creating = new Set<string>();
  const requests: RequestRecord[] = [];
  let version = 0;

  const record = (method: string, path: string, status: number): number => {
    requests.push({ method, path, status });
    return status;
  };

  const parentOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const exists = (p: string): boolean => dirs.has(p) || files.has(p);

  const pathOf = (url: string): string => {
    const rel = url.startsWith(URL_BASE) ? url.slice(URL_BASE.length) : url;
    return rel.replace(/^\/+|\/+$/g, '').split('/').map(decodeURIComponent)
      .filter((s) => s.length > 0)
      .join('/');
  };

  const href = (p: string, isDir: boolean): string =>
    `${HREF_ROOT}/${p.split('/').map(encodeURIComponent).join('/')}${isDir ? '/' : ''}`;

  const entryXml = (p: string): string => {
    const isDir = dirs.has(p);
    const f = files.get(p);
    const size = f ? enc.encode(f.body).length : 0;
    return `<d:response><d:href>${href(p, isDir)}</d:href><d:propstat><d:prop>`
      + `<d:getetag>"etag-${version}-${p.replace(/[^A-Za-z0-9]/g, '_')}"</d:getetag>`
      + '<d:getlastmodified>Mon, 12 Jan 2026 10:00:00 GMT</d:getlastmodified>'
      + (isDir ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength>`)
      + (f?.checksum ? `<oc:checksums><oc:checksum>SHA256:${f.checksum}</oc:checksum></oc:checksums>` : '')
      + `<oc:fileid>id-${p.replace(/[^A-Za-z0-9]/g, '_')}</oc:fileid>`
      + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
  };

  const multistatus = (paths: string[]): string =>
    '<?xml version="1.0" encoding="utf-8"?>'
    + '<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">'
    + paths.map(entryXml).join('')
    + '</d:multistatus>';

  const listing = (target: string, depth: string): string[] => {
    const below = [...dirs, ...files.keys()].filter((p) => p.startsWith(`${target}/`));
    if (depth === '0') return [target];
    if (depth === '1') return [target, ...below.filter((p) => !p.slice(target.length + 1).includes('/'))];
    return [target, ...below];
  };

  const handle = (req: { url: string; method?: string; headers?: Record<string, string>; body?: unknown }): Promise<FakeResponse> => {
    const method = req.method ?? 'GET';
    const path = pathOf(req.url);

    if (method === 'PROPFIND') {
      if (!exists(path)) return Promise.resolve(reply(record(method, path, 404)));
      const depth = req.headers?.Depth ?? 'infinity';
      return Promise.resolve(reply(record(method, path, 207), multistatus(listing(path, depth))));
    }

    if (method === 'MKCOL') {
      // Order matters and mirrors Sabre: an existing collection is 405 whatever else is going on;
      // only then does the in-flight lock (423) and the missing-parent check (409) apply.
      if (dirs.has(path)) return Promise.resolve(reply(record(method, path, 405)));
      if (opts.mkcolCreateStatus) return Promise.resolve(reply(record(method, path, opts.mkcolCreateStatus)));
      if (creating.has(path)) return Promise.resolve(reply(record(method, path, 423), LOCKED_BODY));
      const parent = parentOf(path);
      if (parent && !dirs.has(parent)) return Promise.resolve(reply(record(method, path, 409), CONFLICT_BODY));
      creating.add(path);
      return afterMacrotasks(CREATE_MACROTASKS, () => {
        creating.delete(path);
        dirs.add(path);
        version++;
        return reply(record(method, path, 201));
      });
    }

    if (method === 'PUT') {
      const parent = parentOf(path);
      // Nextcloud's files DAV answers 404 (not the RFC's 409) when the parent collection is missing.
      if (parent && !dirs.has(parent)) return Promise.resolve(reply(record(method, path, 404)));
      const checksum = (req.headers?.['OC-Checksum'] ?? '').match(/SHA256:([0-9a-fA-F]+)/i)?.[1]?.toLowerCase() ?? null;
      const body = req.body instanceof ArrayBuffer ? dec.decode(req.body) : String(req.body ?? '');
      files.set(path, { body, checksum, mtime: MTIME });
      version++;
      return Promise.resolve(reply(record(method, path, 201)));
    }

    if (method === 'GET') {
      const f = files.get(path);
      if (!f) return Promise.resolve(reply(record(method, path, 404)));
      return Promise.resolve(reply(record(method, path, 200), f.body, toBuf(f.body)));
    }

    if (method === 'DELETE') {
      files.delete(path);
      dirs.delete(path);
      version++;
      return Promise.resolve(reply(record(method, path, 204)));
    }

    // Nothing else is reached by the full-scan upload path these tests exercise; answering 501
    // rather than a silent 200 keeps an unexpected call visible instead of quietly passing.
    return Promise.resolve(reply(record(method, path, 501)));
  };

  return {
    dirs,
    files,
    requests,
    handle,
    /** How many MKCOLs the session sent for one VAULT-RELATIVE path (e.g. `F`, `F/x`). */
    mkcolCount: (rel: string): number =>
      requests.filter((r) => r.method === 'MKCOL' && r.path === `${BASE}/${rel}`).length,
    hasDir: (rel: string): boolean => dirs.has(`${BASE}/${rel}`),
    hasFile: (rel: string): boolean => files.has(`${BASE}/${rel}`),
  };
}

type FakeServer = ReturnType<typeof makeServer>;

function makeStateAdapter(): DataAdapter {
  const store: Record<string, string> = {};
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(async (p: string) => { delete store[p]; }),
    rename: jest.fn(async (f: string, t: string) => { store[t] = store[f]; delete store[f]; }),
    stat: jest.fn(), list: jest.fn(), readBinary: jest.fn(), writeBinary: jest.fn(),
  } as unknown as DataAdapter;
}

/** In-memory local vault (path → body). */
function makeLocalAdapter(files: Record<string, string>) {
  const sizeOf = (p: string): number => enc.encode(files[p]).length;
  return {
    files,
    listVaultFiles: jest.fn(() => Object.keys(files).map((p) => ({ path: p, size: sizeOf(p), mtime: MTIME }))),
    list: jest.fn(async () => ({ files: [] as string[], folders: [] as string[] })),
    stat: jest.fn(async (p: string) => (p in files ? { size: sizeOf(p), mtime: MTIME } : null)),
    exists: jest.fn(async (p: string) => p in files),
    read: jest.fn(async (p: string) => files[p] ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(files[p] ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string) => { files[p] = d; }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files[p] = dec.decode(d); }),
    setMtime: jest.fn(async () => undefined),
    remove: jest.fn(async (p: string) => { delete files[p]; }),
  };
}

interface HarnessOptions {
  /** Local vault contents (path → body). The vault has never been synced (StateDB is empty). */
  localFiles: Record<string, string>;
  /** Passed straight to the fake server. */
  server?: ServerOptions;
}

/**
 * A first sync of an untracked vault whose remote folder exists and is empty.
 *
 * `getAllFolders()` deliberately answers `[]`. Directory reconciliation runs after the uploads and
 * would otherwise MKCOL folders the uploads had just created, which would muddy the per-path MKCOL
 * counts these tests turn on. With no local folders it classifies every remote folder as
 * `!L && R && !T` → create locally, which touches nothing on the server.
 */
async function buildHarness(o: HarnessOptions) {
  const server = makeServer(o.server ?? {});
  mockRequestUrl.mockImplementation(server.handle);

  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const local = makeLocalAdapter({ ...o.localFiles });
  const client = new NextcloudClient(SETTINGS, 'pw', BASE);

  const trashed: string[] = [];
  const app = {
    vault: {
      adapter: {
        mkdir: jest.fn(async () => undefined),
        exists: jest.fn(async (p: string) => p in local.files),
        remove: jest.fn(async (p: string) => { delete local.files[p]; }),
      },
      getAllFolders: () => [] as TFolder[],
      getAbstractFileByPath: (p: string) => (p in local.files ? new TFile(p) : null),
    },
    fileManager: {
      trashFile: jest.fn(async (f: TFile | TFolder) => { trashed.push(f.path); }),
    },
  };

  const features: NextcloudFeatures = {
    isNextcloud: true, version: '34', hasChecksums: true, hasFilesLocking: false,
    hasBulkUpload: false, syncToken: null,
  };
  const logger = { log: jest.fn() };
  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() };

  const engine = new SyncEngine({
    app, settings: { ...SETTINGS },
    localAdapter: local, stateDB, statusBar,
    webdavFactory: { createClient: jest.fn(async () => ({ client, features })) },
    logger, pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);

  return {
    engine, stateDB, server, local, trashed,
    logs: (): string => logger.log.mock.calls.map((c) => String(c[0])).join('\n'),
  };
}

const errorPaths = (s: { errors: { path: string }[] }): string[] => s.errors.map((e) => e.path).sort();

beforeEach(() => {
  mockRequestUrl.mockReset();
  // testEnvironment is 'node'; isBlockedByWifiOnly reads navigator.connection. syncOnWifiOnly=false
  // short-circuits before it, but guard the global so environments without `navigator` don't throw.
  (globalThis as { navigator?: unknown }).navigator ??= {};
});

// Both clients parse PROPFIND XML with `new DOMParser()`, which the a-layer `node` env lacks.
let prevDOMParser: unknown;
beforeAll(() => {
  prevDOMParser = (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
  (globalThis as unknown as { DOMParser: unknown }).DOMParser = require('@xmldom/xmldom').DOMParser;
});
afterAll(() => { (globalThis as unknown as { DOMParser: unknown }).DOMParser = prevDOMParser; });

describe('MSF-12 two files under a brand-new two-level folder both reach the server in ONE session', () => {
  it('uploads F/a.md and F/sub/b.md with no errors, and leaves both collections on the server', async () => {
    // The reported failure, stated as the user sees it: create a folder, put a note in it and a note
    // in a subfolder, sync once. Observed before the fix (live b-1, ~1 run in 4):
    //   errors: [{"path":"GDP30/a.md","message":"HTTP 404 (PUT)"},
    //            {"path":"GDP30/sub/b.md","message":"HTTP 404 (PUT)"}]
    const h = await buildHarness({
      localFiles: { 'F/a.md': 'body of a\n', 'F/sub/b.md': 'body of b\n' },
    });

    await h.engine.syncManual({ manual: true });

    const summary = h.engine.getLastSessionSummary()!;
    expect(errorPaths(summary)).toEqual([]);
    expect(summary.errorCount).toBe(0);
    expect(summary.uploadedCount).toBe(2);

    // Both ancestors really exist afterwards — not merely "not reported as an error". The chain that
    // loses the race caches `F/sub` as created after a 409, so before the fix the folder is missing
    // from the server while the client is convinced it made it.
    expect(h.server.hasDir('F')).toBe(true);
    expect(h.server.hasDir('F/sub')).toBe(true);
    expect(h.server.hasFile('F/a.md')).toBe(true);
    expect(h.server.hasFile('F/sub/b.md')).toBe(true);

    await h.stateDB.flush();
  });
});

describe('MSF-13 the shared ancestor is created by exactly one request', () => {
  it('issues a single MKCOL for F even though two upload chains need it at the same time', async () => {
    // The mechanism, asserted directly. Two concurrent MKCOLs on one collection is what the server
    // answers 423 to, and one 423 recorded as "created" is what poisons the rest of the session.
    // Counting requests (rather than asserting the absence of a 423) states the contract positively:
    // callers that need the same directory share one request instead of racing for it.
    const h = await buildHarness({
      localFiles: { 'F/a.md': 'body of a\n', 'F/sub/b.md': 'body of b\n' },
    });

    await h.engine.syncManual({ manual: true });

    expect(h.server.mkcolCount('F')).toBe(1);
    expect(h.server.mkcolCount('sub')).toBe(0); // sanity: paths are counted vault-relative, not by name
    expect(h.server.requests.filter((r) => r.method === 'MKCOL' && r.status === 423)).toEqual([]);

    await h.stateDB.flush();
  });
});

describe('MSF-14 a deeper tree behaves the same, one MKCOL per level', () => {
  it('uploads all three files and creates F, F/x, F/x/y and F/x/y/z exactly once each', async () => {
    // Three chains (parents `F`, `F/x`, `F/x/y/z`) contend for `F`, and two of them also contend for
    // `F/x`. Depth is what multiplies the race, so a fix that only special-cased the two-level case
    // would show up here.
    const h = await buildHarness({
      localFiles: {
        'F/a.md': 'body of a\n',
        'F/x/other.md': 'body of other\n',
        'F/x/y/z/deep.md': 'body of deep\n',
      },
    });

    await h.engine.syncManual({ manual: true });

    const summary = h.engine.getLastSessionSummary()!;
    expect(errorPaths(summary)).toEqual([]);
    expect(summary.errorCount).toBe(0);
    expect(summary.uploadedCount).toBe(3);

    for (const dir of ['F', 'F/x', 'F/x/y', 'F/x/y/z']) {
      expect({ dir, mkcols: h.server.mkcolCount(dir) }).toEqual({ dir, mkcols: 1 });
      expect(h.server.hasDir(dir)).toBe(true);
    }
    for (const f of ['F/a.md', 'F/x/other.md', 'F/x/y/z/deep.md']) expect(h.server.hasFile(f)).toBe(true);

    await h.stateDB.flush();
  });
});

describe('MSF-15 a single new level keeps working exactly as before', () => {
  it('uploads F/a.md and F/b.md through one MKCOL, unchanged by the fix', async () => {
    // The regression half. Both files share the parent `F`, so `serializeByDir` already puts them on
    // one chain and there is no race to fix here — the second PUT simply finds the folder the first
    // one created. This is the configuration that was 5/5 stable on the live instance, and it must
    // still cost exactly one MKCOL and one PUT per file afterwards.
    const h = await buildHarness({
      localFiles: { 'F/a.md': 'body of a\n', 'F/b.md': 'body of b\n' },
    });

    await h.engine.syncManual({ manual: true });

    const summary = h.engine.getLastSessionSummary()!;
    expect(errorPaths(summary)).toEqual([]);
    expect(summary.errorCount).toBe(0);
    expect(summary.uploadedCount).toBe(2);
    expect(h.server.mkcolCount('F')).toBe(1);
    expect(h.server.hasFile('F/a.md')).toBe(true);
    expect(h.server.hasFile('F/b.md')).toBe(true);

    await h.stateDB.flush();
  });
});

describe('MSF-16 an ancestor that genuinely cannot be created costs one file, not the session', () => {
  it('records the error for the file below it and still uploads everything else', async () => {
    // Distinguishing a fixable race from a real refusal matters: the fix must not turn "the server
    // says no" into a thrown session. A permanently failing MKCOL (403 here) is reported against the
    // one file that needed the folder, every other file still transfers, and the session ends
    // normally so the next one retries — the self-healing property the whole design rests on.
    const h = await buildHarness({
      localFiles: { 'top.md': 'body of top\n', 'F/a.md': 'body of a\n' },
      server: { mkcolCreateStatus: 403 },
    });

    await h.engine.syncManual({ manual: true });

    const summary = h.engine.getLastSessionSummary()!;
    expect(errorPaths(summary)).toEqual(['F/a.md']);
    expect(summary.errorCount).toBe(1);

    // The session ran to completion rather than stopping at the failure.
    expect(h.server.hasFile('top.md')).toBe(true);
    expect(summary.uploadedCount).toBe(1);
    expect(h.server.hasFile('F/a.md')).toBe(false);
    expect(h.server.hasDir('F')).toBe(false);

    await h.stateDB.flush();
  });
});
