// docs/spec.md §5.3b: an edit saved to disk while a transfer of the same note is in flight is never stranded or overwritten.
// Drives the real SyncEngine (watch path and full-sync classifier) with an in-memory vault and server.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, DavSyncSettings, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';
import { sha256 } from '../../../src/util/hash';
import { computeSyncScopeFingerprint } from '../../../src/sync/plugins/scopeFingerprint';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const hashOf = (s: string): Promise<string> => sha256(toBuf(s));
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';
const PATH = 'note.md';

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

function makeSummary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], pluginsNeedingRestart: [], errors: [],
    oversizeSkippedPaths: new Set(),
  };
}

interface VaultFile { body: string; mtime: number }

// The editor saving to disk: new body and a new mtime, as Obsidian's own save does. `file` is null once the note is deleted.
function makeVault(body: string, mtime: number) {
  const state: { file: VaultFile | null; afterRead: (() => void) | null } = { file: { body, mtime }, afterRead: null };
  const save = (b: string, m: number): void => { state.file = { body: b, mtime: m }; };
  // Runs once, right after the next readBinary produced its bytes: "a save lands just after the read".
  const saveAfterNextRead = (b: string, m: number): void => { state.afterRead = () => save(b, m); };
  const remove = (): void => { state.file = null; };
  const present = (): VaultFile => {
    if (!state.file) throw new Error('ENOENT: no such file');
    return state.file;
  };
  const adapter = {
    stat: jest.fn(async () => (state.file ? { size: enc.encode(state.file.body).length, mtime: state.file.mtime } : null)),
    exists: jest.fn(async () => state.file !== null),
    read: jest.fn(async () => present().body),
    readBinary: jest.fn(async () => {
      const bytes = toBuf(present().body);
      const hook = state.afterRead;
      state.afterRead = null;
      hook?.();
      return bytes;
    }),
    atomicWrite: jest.fn(async (_p: string, d: string, m?: number) => save(d, m ?? 99_000)),
    atomicWriteBinary: jest.fn(async (_p: string, d: ArrayBuffer, m?: number) => save(dec.decode(d), m ?? 99_000)),
    writeBinary: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
  };
  return {
    get file(): VaultFile | null { return state.file; },
    save, saveAfterNextRead, remove, adapter,
  };
}

async function buildEngine(
  localAdapter: Record<string, unknown>,
  client: Record<string, unknown>,
  upload: jest.Mock,
  notify: jest.Mock = jest.fn(),
) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();
  const bases = new Map<string, string>();
  const baseStore = {
    get: jest.fn((p: string) => bases.get(p)), set: jest.fn((p: string, b: string) => { bases.set(p, b); }),
    delete: jest.fn((p: string) => { bases.delete(p); }),
    requestSave: jest.fn(), flush: jest.fn(async () => undefined),
  };
  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS },
    localAdapter, stateDB, baseStore, webdavFactory: {},
    statusBar: new Proxy({}, { get: () => () => undefined }),
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
    isBeingEdited: () => false,
    notify,
  } as never);
  const e = engine as unknown as Record<string, unknown>;
  e.client = client;
  // A Nextcloud server: the client reports checksums, so the upload records the sha256 without a re-stat.
  e.features = { isNextcloud: true, hasAccountDav: false };
  e.uploadStrategy = { upload };
  return { engine, stateDB, baseStore, bases, notify };
}

const remoteOf = (body: string, over: Partial<RemoteFileInfo>): RemoteFileInfo => ({
  path: PATH, fileId: 'f1', checksum: null, etag: 'e0',
  size: enc.encode(body).length, lastModified: 9_000, creationTime: 0, ...over,
});

const processRemote = (e: SyncEngine, r: RemoteFileInfo, s: SyncSessionSummary): Promise<void> =>
  (e as unknown as { processRemoteFile: (r: RemoteFileInfo, s: SyncSessionSummary) => Promise<void> })
    .processRemoteFile(r, s);

// Baseline: C0 synced on both sides, with the post-write stat signature recorded.
async function seedBaseline(stateDB: StateDB, bases: Map<string, string>, body: string, mtime: number): Promise<void> {
  const h = await hashOf(body);
  stateDB.setFile({
    path: PATH, localHash: h, remoteId: h, idType: 'sha256',
    size: enc.encode(body).length, mtime, remoteFileId: 'f1', isConflicted: false,
    localMtime: mtime, localSize: enc.encode(body).length,
  });
  bases.set(PATH, body);
}

const C0 = 'a\n';
const C1 = 'a\nb\n';      // what the watch cycle reads and uploads
const C2 = 'a\nb\nc\n';   // saved by the editor while that PUT is in flight

async function uploadWithEditInFlight(c1Mtime = 5_000, c2Mtime = 6_000) {
    const vault = makeVault(C1, c1Mtime);
    let serverBody = C0;
    let serverChecksum = await hashOf(C0);
    const upload = jest.fn(async (_c: unknown, _p: string, data: ArrayBuffer) => {
      vault.save(C2, c2Mtime);             // the user keeps typing; Obsidian saves during the PUT
      serverBody = dec.decode(data);
      serverChecksum = await hashOf(serverBody);
      return 'uploaded' as const;
    });
    const client = {
      statFile: jest.fn(async () => remoteOf(serverBody, { checksum: serverChecksum, etag: `e-${serverChecksum.slice(0, 6)}` })),
      downloadFile: jest.fn(async () => toBuf(serverBody)),
    };
    const built = await buildEngine(vault.adapter, client, upload);
    await seedBaseline(built.stateDB, built.bases, C0, 1_000);

    await built.engine.syncSingleFile(PATH);  // cycle 1: uploads C1
    expect(upload).toHaveBeenCalledTimes(1);
    expect(serverBody).toBe(C1);
    return { ...built, vault, upload, client, server: () => serverBody };
}

describe('[SPEC:ETG-1] an edit saved during an upload (watch path)', () => {

  it('[SPEC:ETG-1] records a baseline whose stat signature describes the body it hashed', async () => {
    const { stateDB, vault } = await uploadWithEditInFlight();
    const st = stateDB.getFile(PATH)!;
    // Signature of C2 recorded next to the hash of C1 means the next stat check reads C2 as "unchanged".
    const sigDescribesUploaded = st.localSize === enc.encode(C1).length && st.localMtime === 5_000;
    const sigDescribesDisk = st.localSize === enc.encode(vault.file?.body).length && st.localMtime === vault.file?.mtime;
    expect({ localHash: st.localHash === (await hashOf(C1)), sigDescribesUploaded, sigDescribesDisk })
      .toEqual({ localHash: true, sigDescribesUploaded: true, sigDescribesDisk: false });
  });

  it('[SPEC:ETG-2] uploads the edit saved during the PUT on the next watch cycle', async () => {
    const { engine, upload, server } = await uploadWithEditInFlight();
    await engine.syncSingleFile(PATH);       // cycle 2: fired by the save of C2
    expect(server()).toBe(C2);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('[SPEC:ETG-10] a later full sync does not replace that edit when the listing carries no SHA256 (etag identity)', async () => {
    const { engine, vault, client } = await uploadWithEditInFlight();
    client.downloadFile.mockImplementation(async () => toBuf(C1));
    await processRemote(engine, remoteOf(C1, { checksum: null, etag: 'e-after-put' }), makeSummary());
    expect(vault.file?.body).toBe(C2);
    // Whether or not the body is fetched, C1 is never written back over the edit.
    const wroteC1 = [
      ...vault.adapter.atomicWrite.mock.calls.map((c) => c[1]),
      ...vault.adapter.atomicWriteBinary.mock.calls.map((c) => dec.decode(c[1])),
    ].filter((body) => body === C1);
    expect(wroteC1).toEqual([]);
  });

  it('[SPEC:ETG-10] a later full sync merges instead of overwriting when another device changed the note', async () => {
    const { engine, vault, client, upload } = await uploadWithEditInFlight();
    upload.mockImplementation(async () => 'uploaded' as const);   // the PUT of the merge result carries no save of its own
    const R = 'x\na\nb\n';                    // another device prepended a line to C1
    client.downloadFile.mockImplementation(async () => toBuf(R));
    await processRemote(engine, remoteOf(R, { checksum: await hashOf(R), etag: 'e-other' }), makeSummary());
    expect(vault.file?.body).toContain('c\n'); // the local edit survives (merge or conflict, not overwrite)
    expect(vault.file?.body).toContain('x\n'); // and so does the other device's line
  });
});

type Vault = ReturnType<typeof makeVault>;
const retryQueueOf = (e: SyncEngine): string[] => (e as unknown as { retryQueue: string[] }).retryQueue;

// A download decided by the full-sync classifier: C1 on disk and in the baseline, a remote whose identity moved (etag only,
// no SHA256, unless `over` says otherwise). `duringGet` runs inside the GET, the moment the editor saves or the note is deleted.
async function downloadWithChangeInFlight(
  duringGet: (vault: Vault) => void,
  remote: { body: string; over: Partial<RemoteFileInfo> } = { body: C1, over: { checksum: null, etag: 'e-moved' } },
  prepare: (engine: SyncEngine) => void = () => undefined,
) {
  const vault = makeVault(C1, 5_000);
  const client = {
    statFile: jest.fn(),
    downloadFile: jest.fn(async () => {
      duringGet(vault);
      return toBuf(remote.body);
    }),
  };
  const built = await buildEngine(vault.adapter, client, jest.fn());
  await seedBaseline(built.stateDB, built.bases, C1, 5_000);
  prepare(built.engine);
  const summary = makeSummary();
  const remoteInfo = remoteOf(remote.body, remote.over);
  await processRemote(built.engine, remoteInfo, summary);
  return { ...built, vault, client, summary, remote: remoteInfo };
}

describe('[SPEC:ETG-5] an edit saved during a download (full-sync classifier)', () => {
  it('[SPEC:ETG-5] does not write the fetched body over an edit saved while the GET was in flight', async () => {
    // The user resumes typing after the edit guard was checked: the save lands inside the GET.
    const { stateDB, engine, vault, client, summary } = await downloadWithChangeInFlight((v) => v.save(C2, 6_000));
    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(vault.file?.body).toBe(C2);
    // The deferral keeps the hash (the merge base still matches it) and drops only the stat signature.
    const st = stateDB.getFile(PATH)!;
    expect(st.localMtime).toBeUndefined();
    expect(st.localSize).toBeUndefined();
    expect(st.localHash).toBe(await hashOf(C1));
    expect(retryQueueOf(engine)).toContain(PATH);
    expect(summary.errorCount).toBe(0);
    expect(summary.downloadedCount).toBe(0);
  });
});

// Real wall-clock values: the safety window (docs/spec.md §4.2) re-hashes a file whose mtime is within 2000 ms of now.
// The watch debounce fires the next cycle 2000 ms after the save, i.e. exactly at the edge of that window.
describe('[SPEC:ETG-2] an edit saved during an upload, at the real debounce timing', () => {
  const T = 1_800_000_000_000; // the moment Obsidian saves C2 during the PUT
  afterEach(() => jest.restoreAllMocks());

  async function secondCycleAt(now: number) {
    jest.spyOn(Date, 'now').mockReturnValue(T - 1_000);
    const built = await uploadWithEditInFlight(T - 3_000, T);
    (Date.now as jest.Mock).mockReturnValue(now);
    await built.engine.syncSingleFile(PATH);
    return built;
  }

  it('[SPEC:ETG-2] cycle 2 at save + 2000 ms (the debounce delay) uploads the edit', async () => {
    const { server } = await secondCycleAt(T + 2_000);
    expect(server()).toBe(C2);
  });

  it('[SPEC:ETG-2] control: cycle 2 at save + 1999 ms is caught by the safety window', async () => {
    const { server } = await secondCycleAt(T + 1_999);
    expect(server()).toBe(C2);
  });
});

// ---- engine-level coverage of the signature invariant (docs/spec.md §5.3b) ----

const once = (fn: () => void): (() => void) => {
  let done = false;
  return () => { if (!done) { done = true; fn(); } };
};

// A server that accepts every PUT and answers statFile / getFiles / downloadFile with what it holds. `duringPut` runs
// inside the PUT, the moment an editor save (or a delete) can land. `initial` null means the note is not on the server.
async function makeServer(initial: string | null, duringPut?: () => void) {
  let body = initial;
  let checksum = initial === null ? null : await hashOf(initial);
  const upload = jest.fn(async (_c: unknown, _p: string, data: ArrayBuffer) => {
    duringPut?.();
    body = dec.decode(data);
    checksum = await hashOf(body);
    return 'uploaded' as const;
  });
  const remote = (): RemoteFileInfo | null =>
    (body === null ? null : remoteOf(body, { checksum, etag: `e-${(checksum ?? '').slice(0, 6)}` }));
  const client = {
    statFile: jest.fn(async () => remote()),
    getFiles: jest.fn(async () => { const r = remote(); return r ? [r] : []; }),
    downloadFile: jest.fn(async () => toBuf(body ?? '')),
    deleteFile: jest.fn(async () => undefined),
  };
  return { upload, client, remote, body: () => body };
}

interface InitialPlan {
  uploads: string[]; downloads: string[]; conflicts: string[]; deletes: string[]; unchanged: string[];
  unchangedSignatures: Map<string, { mtime: number; size: number }>;
}
type LocalStats = Map<string, { size: number; mtime: number }>;
interface PlanInternals {
  buildInitialPlan(localFiles: LocalStats, remoteFiles: RemoteFileInfo[]): Promise<InitialPlan>;
  executePlan(plan: InitialPlan, remoteFiles: RemoteFileInfo[], summary: SyncSessionSummary, localFiles: LocalStats): Promise<void>;
}
const planOf = (e: SyncEngine): PlanInternals => e as unknown as PlanInternals;
const localStatsOf = (body: string, mtime: number): LocalStats => new Map([[PATH, { size: enc.encode(body).length, mtime }]]);
const bytesLen = (s: string): number => enc.encode(s).length;

describe('[SPEC:ETG-1] initial-sync upload records a pre-read signature', () => {
  async function initialUploadWithEditInFlight() {
    const vault = makeVault(C1, 5_000);
    const server = await makeServer(null, once(() => vault.save(C2, 6_000))); // the editor saves C2 during the PUT
    const built = await buildEngine(vault.adapter, server.client, server.upload);
    const plan: InitialPlan = {
      uploads: [PATH], downloads: [], conflicts: [], deletes: [], unchanged: [], unchangedSignatures: new Map(),
    };
    await planOf(built.engine).executePlan(plan, [], makeSummary(), localStatsOf(C1, 5_000));
    return { ...built, vault, server };
  }

  it('[SPEC:ETG-1] records the stat taken before the read and the hash of the bytes sent', async () => {
    const { stateDB, vault, server } = await initialUploadWithEditInFlight();
    expect(server.upload).toHaveBeenCalledTimes(1);
    expect(server.body()).toBe(C1);
    expect(vault.file?.body).toBe(C2);       // the save during the PUT is on disk
    const st = stateDB.getFile(PATH)!;
    expect(st.localHash).toBe(await hashOf(C1));
    expect(st.localMtime).toBe(5_000);
    expect(st.localSize).toBe(bytesLen(C1));
  });

  it('[SPEC:ETG-1] the next watch cycle uploads the edit saved during the initial-sync PUT', async () => {
    const { engine, server } = await initialUploadWithEditInFlight();
    await engine.syncSingleFile(PATH);
    expect(server.body()).toBe(C2);
    expect(server.upload).toHaveBeenCalledTimes(2);
  });
});

describe('[SPEC:ETG-3] engine convergence records a pre-read signature', () => {
  // The identical-content convergence of processRemoteFile: disk C1 equals the remote C1, the baseline is C0.
  async function convergeWithSaveAfterRead() {
    const vault = makeVault(C1, 5_000);
    const server = await makeServer(C1);
    const built = await buildEngine(vault.adapter, server.client, server.upload);
    await seedBaseline(built.stateDB, built.bases, C0, 1_000);
    const remote = remoteOf(C1, { checksum: await hashOf(C1) });
    vault.saveAfterNextRead(C2, 6_000);      // the editor saves C2 right after the classifier read C1
    await processRemote(built.engine, remote, makeSummary());
    return { ...built, vault, server, remote };
  }

  it('[SPEC:ETG-3] processRemoteFile records the stat taken before the read, not the one of the later save', async () => {
    const { stateDB, server } = await convergeWithSaveAfterRead();
    const st = stateDB.getFile(PATH)!;
    expect(st.localHash).toBe(await hashOf(C1));
    expect(st.localMtime).toBe(5_000);
    expect(st.localSize).toBe(bytesLen(C1));
    expect(server.upload).not.toHaveBeenCalled();   // converged: nothing transferred yet
    expect(server.client.downloadFile).not.toHaveBeenCalled();
  });

  it('[SPEC:ETG-3] the same remote classified again uploads the saved body', async () => {
    const { engine, server, remote } = await convergeWithSaveAfterRead();
    await processRemote(engine, remote, makeSummary());
    expect(server.upload).toHaveBeenCalledTimes(1);
    expect(dec.decode(server.upload.mock.calls[0][2])).toBe(C2);
  });

  describe('initial sync, a path classified unchanged (buildInitialPlan then executePlan)', () => {
    async function unchangedWithSaveAfterRead() {
      const vault = makeVault(C1, 5_000);
      const server = await makeServer(C1);
      const built = await buildEngine(vault.adapter, server.client, server.upload);
      const remote = remoteOf(C1, { checksum: await hashOf(C1) });
      const localFiles = localStatsOf(C1, 5_000);
      vault.saveAfterNextRead(C2, 6_000);    // the editor saves C2 right after the plan hashed C1
      const plan = await planOf(built.engine).buildInitialPlan(localFiles, [remote]);
      await planOf(built.engine).executePlan(plan, [remote], makeSummary(), localFiles);
      return { ...built, vault, server, remote, plan };
    }

    it('[SPEC:ETG-3] records the stat taken before the read as the signature', async () => {
      const { stateDB, plan } = await unchangedWithSaveAfterRead();
      expect(plan.unchanged).toEqual([PATH]);
      expect(plan.unchangedSignatures.get(PATH)).toEqual({ mtime: 5_000, size: bytesLen(C1) });
      const st = stateDB.getFile(PATH)!;
      expect(st.localHash).toBe(await hashOf(C1));
      expect(st.localMtime).toBe(5_000);
      expect(st.localSize).toBe(bytesLen(C1));
    });

    it('[SPEC:ETG-3] the next classification of that path uploads the saved body', async () => {
      const { engine, server, remote } = await unchangedWithSaveAfterRead();
      expect(server.upload).not.toHaveBeenCalled();
      await processRemote(engine, remote, makeSummary());
      expect(server.upload).toHaveBeenCalledTimes(1);
      expect(dec.decode(server.upload.mock.calls[0][2])).toBe(C2);
    });

    it('[SPEC:ETG-3] a path whose stat is null is in none of uploads, downloads, conflicts, unchanged', async () => {
      const vault = makeVault(C1, 5_000);
      const server = await makeServer(C1);
      const { engine } = await buildEngine(vault.adapter, server.client, server.upload);
      const localFiles = localStatsOf(C1, 5_000);   // the scan saw the file ...
      vault.remove();                                 // ... and it vanished before the plan statted it
      const plan = await planOf(engine).buildInitialPlan(localFiles, [remoteOf(C1, { checksum: await hashOf(C1) })]);
      expect(plan).toMatchObject({ uploads: [], downloads: [], conflicts: [], unchanged: [] });
      expect(plan.unchangedSignatures.size).toBe(0);
      expect(vault.adapter.readBinary).not.toHaveBeenCalled();
    });
  });
});

describe('[SPEC:ETG-4] no concurrent edit converges with zero transfers', () => {
  it('[SPEC:ETG-4] a watch upload with no save is followed by a no-op cycle: no read, no stat, no listing, no transfer', async () => {
    const vault = makeVault(C1, 5_000);
    const server = await makeServer(C0);
    const { engine, stateDB, bases } = await buildEngine(vault.adapter, server.client, server.upload);
    await seedBaseline(stateDB, bases, C0, 1_000);

    await engine.syncSingleFile(PATH);       // cycle 1: uploads C1, nothing saved meanwhile
    expect(server.upload).toHaveBeenCalledTimes(1);
    expect(server.body()).toBe(C1);

    const statCalls = server.client.statFile.mock.calls.length;
    const listCalls = server.client.getFiles.mock.calls.length;
    const reads = vault.adapter.readBinary.mock.calls.length;
    await engine.syncSingleFile(PATH);       // cycle 2: the recorded signature matches the file
    expect(server.upload).toHaveBeenCalledTimes(1);
    expect(server.client.downloadFile).not.toHaveBeenCalled();
    expect(server.client.statFile.mock.calls.length).toBe(statCalls);
    expect(server.client.getFiles.mock.calls.length).toBe(listCalls);
    expect(vault.adapter.readBinary.mock.calls.length).toBe(reads);
  });

  it('[SPEC:ETG-4] a save with identical content and a new mtime during the PUT is not uploaded again', async () => {
    const vault = makeVault(C1, 5_000);
    const server = await makeServer(C0, once(() => vault.save(C1, 6_000)));
    const { engine, stateDB, bases } = await buildEngine(vault.adapter, server.client, server.upload);
    await seedBaseline(stateDB, bases, C0, 1_000);

    await engine.syncSingleFile(PATH);       // cycle 1: uploads C1; the mtime moves to 6000 during the PUT
    expect(server.upload).toHaveBeenCalledTimes(1);
    expect(vault.file?.mtime).toBe(6_000);

    await engine.syncSingleFile(PATH);       // cycle 2: the signature differs, the hash does not
    expect(server.upload).toHaveBeenCalledTimes(1);
    expect(server.client.downloadFile).not.toHaveBeenCalled();
  });

  it('[SPEC:ETG-4] a download with no save is not repeated for the same remote', async () => {
    const vault = makeVault(C0, 1_000);
    const server = await makeServer(C1);
    const { engine, stateDB, bases } = await buildEngine(vault.adapter, server.client, server.upload);
    await seedBaseline(stateDB, bases, C0, 1_000);
    const remote = server.remote()!;

    await processRemote(engine, remote, makeSummary());
    expect(server.client.downloadFile).toHaveBeenCalledTimes(1);
    expect(vault.file?.body).toBe(C1);

    await processRemote(engine, remote, makeSummary());
    expect(server.client.downloadFile).toHaveBeenCalledTimes(1);
    expect(server.upload).not.toHaveBeenCalled();
  });
});

describe('[SPEC:ETG-1] a file deleted during the upload is not kept as local content', () => {
  it('[SPEC:ETG-1] is neither re-created nor uploaded again by the next classification', async () => {
    const vault = makeVault(C1, 5_000);
    const server = await makeServer(C0, once(() => vault.remove()));   // the note is deleted while its PUT is in flight
    const { engine, stateDB, bases } = await buildEngine(vault.adapter, server.client, server.upload);
    await seedBaseline(stateDB, bases, C0, 1_000);

    await engine.syncSingleFile(PATH);       // uploads C1; the file is gone afterwards
    expect(server.upload).toHaveBeenCalledTimes(1);
    expect(vault.file).toBeNull();

    await processRemote(engine, server.remote()!, makeSummary());   // the remote equals the uploaded body
    expect(server.upload).toHaveBeenCalledTimes(1);
    expect(server.client.downloadFile).not.toHaveBeenCalled();
    expect(vault.file).toBeNull();
    // Treated as a local deletion: the uploaded body is removed from the server and the tracking entry goes away.
    expect(server.client.deleteFile).toHaveBeenCalledTimes(1);
    expect(stateDB.getFile(PATH)).toBeUndefined();
  });
});

describe('[SPEC:ETG-9] a deferred download converges on the next sync', () => {
  it('[SPEC:ETG-9] the same remote classified again keeps the edit saved during the GET', async () => {
    const { engine, vault, client, summary, remote } = await downloadWithChangeInFlight((v) => v.save(C2, 6_000));
    expect(vault.file?.body).toBe(C2);
    expect(retryQueueOf(engine)).toContain(PATH);

    client.downloadFile.mockImplementation(async () => toBuf(C1));   // no save during this GET
    await processRemote(engine, remote, summary);
    expect(vault.file?.body).toContain('c\n');
    expect(summary.errorCount).toBe(0);
  });
});

describe('[SPEC:ETG-9] an existing stranded record converges without loss', () => {
  it('[SPEC:ETG-9] keeps the stranded edit on the first sync and merges it with the remote change on the second', async () => {
    const R = 'x\na\nb\n';                          // another device prepended a line to C1
    const vault = makeVault(C2, 6_000);              // the edit the old baseline stranded
    const server = await makeServer(R);
    const { engine, stateDB, bases } = await buildEngine(vault.adapter, server.client, server.upload);
    // Hash and merge base describe C1, the stat signature describes the C2 on disk: "unchanged" by signature.
    await seedBaseline(stateDB, bases, C1, 6_000);
    stateDB.setFile({ ...stateDB.getFile(PATH)!, localMtime: 6_000, localSize: bytesLen(C2) });
    const remote = server.remote()!;
    expect(remote.checksum).toBe(await hashOf(R));

    await processRemote(engine, remote, makeSummary());
    expect(vault.file?.body).toBe(C2);               // not overwritten by the remote body
    const st = stateDB.getFile(PATH)!;
    expect(st.localMtime).toBeUndefined();           // the false signature is dropped
    expect(st.localSize).toBeUndefined();
    expect(server.upload).not.toHaveBeenCalled();

    await processRemote(engine, remote, makeSummary());
    expect(vault.file?.body).toContain('x\n');       // the remote line ...
    expect(vault.file?.body).toContain('c\n');       // ... and the stranded edit
    expect(server.upload).toHaveBeenCalledTimes(1);
  });
});

describe('[SPEC:ETG-9] a file deleted during the GET converges through the deletion rule', () => {
  it('[SPEC:ETG-9] writes nothing on the first sync and restores the changed remote on the second', async () => {
    const R = 'x\na\nb\n';                          // the server changed after the baseline
    const { engine, vault, client, summary, remote } = await downloadWithChangeInFlight(
      (v) => v.remove(), { body: R, over: { checksum: await hashOf(R), etag: 'e-changed' } },
    );
    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(vault.file).toBeNull();                   // the deleted file is not re-created by the deferred download
    expect(retryQueueOf(engine)).toContain(PATH);

    client.downloadFile.mockImplementation(async () => toBuf(R));    // no delete during this GET
    await processRemote(engine, remote, summary);
    expect(vault.file?.body).toBe(R);                // the deletion is cancelled and the latest body is fetched
    expect(summary.errorCount).toBe(0);
  });
});

describe('[SPEC:ETG-8] a deferred conflict in watch mode shows no notice', () => {
  it('[SPEC:ETG-8] syncSingleFile leaves the edit saved during the GET alone and stays silent', async () => {
    const R = 'x\na\n';
    const rHash = await hashOf(R);
    const vault = makeVault(C1, 5_000);
    const client = {
      statFile: jest.fn(async () => remoteOf(R, { checksum: rHash, etag: 'e-other' })),
      downloadFile: jest.fn(async () => {
        vault.save(C2, 6_000);                       // the editor saves after the conflict was decided
        return toBuf(R);
      }),
    };
    const upload = jest.fn();
    const { engine, stateDB, bases, notify } = await buildEngine(vault.adapter, client, upload);
    await seedBaseline(stateDB, bases, C0, 1_000);

    await engine.syncSingleFile(PATH);
    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(vault.file?.body).toBe(C2);               // the merge result was not written over the save
    expect(upload).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

// ---- engine-level coverage of the local re-check wiring (docs/spec.md §5.3b) ----

describe('[SPEC:ETG-5] a plugin-file download re-checks the local file', () => {
  const R = 'x\na\nb\n';   // differs from the local C1, so a write over the file is visible
  const remoteR = async () => ({ body: R, over: { checksum: await hashOf(R), etag: 'e-moved' } });
  // Forces the plugin arm of processRemoteFile (applyPluginFileAction): the bundle direction says "download" for the path.
  const forceDownload = () => {
    const fileAction = jest.fn(() => 'download' as const);
    const install = (engine: SyncEngine): void => {
      (engine as unknown as { plugins: { fileAction: unknown } }).plugins.fileAction = fileAction;
    };
    return { fileAction, install };
  };

  it('[SPEC:ETG-5] does not write the fetched body over an edit saved while the GET was in flight', async () => {
    const { fileAction, install } = forceDownload();
    const { stateDB, engine, vault, client, summary } = await downloadWithChangeInFlight(
      (v) => v.save(C2, 6_000), await remoteR(), install,
    );
    expect(fileAction).toHaveBeenCalledWith(PATH, expect.objectContaining({ localPresent: true, tracked: true }));
    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(vault.file?.body).toBe(C2);
    expect(retryQueueOf(engine)).toContain(PATH);
    expect(summary.errorCount).toBe(0);
    expect(summary.downloadedCount).toBe(0);
    // The deferral keeps the hash (the merge base still matches it) and drops only the stat signature.
    const st = stateDB.getFile(PATH)!;
    expect(st.localMtime).toBeUndefined();
    expect(st.localSize).toBeUndefined();
    expect(st.localHash).toBe(await hashOf(C1));
  });

  it('[SPEC:ETG-5] control: with no save during the GET the fetched body is written', async () => {
    const { fileAction, install } = forceDownload();
    const { stateDB, engine, vault, summary } = await downloadWithChangeInFlight(() => undefined, await remoteR(), install);
    expect(fileAction).toHaveBeenCalledWith(PATH, expect.objectContaining({ localPresent: true, tracked: true }));
    expect(vault.file?.body).toBe(R);
    expect(summary.downloadedCount).toBe(1);
    expect(summary.errorCount).toBe(0);
    expect(retryQueueOf(engine)).not.toContain(PATH);
    expect(stateDB.getFile(PATH)!.localHash).toBe(await hashOf(R));
  });
});

describe('[SPEC:ETG-7] a download of a file absent at classification re-checks the local path', () => {
  // The path is absent locally when the sync classifies it; the editor creates it while the GET is in flight.
  async function absentAtClassification(duringGet: (vault: Vault) => void) {
    const vault = makeVault(C0, 1_000);
    vault.remove();
    const client = {
      statFile: jest.fn(),
      downloadFile: jest.fn(async () => {
        duringGet(vault);
        return toBuf(C1);
      }),
    };
    const built = await buildEngine(vault.adapter, client, jest.fn());
    const remote = remoteOf(C1, { checksum: await hashOf(C1) });
    return { ...built, vault, client, remote, summary: makeSummary() };
  }
  const createDuringGet = (v: Vault): void => v.save(C2, 6_000);
  const noChange = (): void => undefined;
  const downloadPlan = (): InitialPlan => ({
    uploads: [], downloads: [PATH], conflicts: [], deletes: [], unchanged: [], unchangedSignatures: new Map(),
  });

  it('[SPEC:ETG-7] processRemoteFile (no baseline) does not overwrite a file created during the GET', async () => {
    const { engine, stateDB, vault, client, remote, summary } = await absentAtClassification(createDuringGet);
    await processRemote(engine, remote, summary);
    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(vault.file?.body).toBe(C2);
    expect(retryQueueOf(engine)).toContain(PATH);
    expect(summary.errorCount).toBe(0);
    expect(summary.downloadedCount).toBe(0);
    expect(stateDB.getFile(PATH)).toBeUndefined();   // no baseline to keep, so nothing is recorded
  });

  it('[SPEC:ETG-7] executePlan (initial-sync download) does not overwrite a file created during the GET', async () => {
    const { engine, stateDB, vault, client, remote, summary } = await absentAtClassification(createDuringGet);
    await planOf(engine).executePlan(downloadPlan(), [remote], summary, new Map());
    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(vault.file?.body).toBe(C2);
    expect(retryQueueOf(engine)).toContain(PATH);
    expect(summary.errorCount).toBe(0);
    expect(summary.downloadedCount).toBe(0);
    expect(stateDB.getFile(PATH)).toBeUndefined();
  });

  it('[SPEC:ETG-7] control: processRemoteFile with no save writes the fetched body', async () => {
    const { engine, stateDB, vault, remote, summary } = await absentAtClassification(noChange);
    await processRemote(engine, remote, summary);
    expect(vault.file?.body).toBe(C1);
    expect(summary.downloadedCount).toBe(1);
    expect(retryQueueOf(engine)).not.toContain(PATH);
    expect(stateDB.getFile(PATH)!.localHash).toBe(await hashOf(C1));
  });

  it('[SPEC:ETG-7] control: executePlan with no save writes the fetched body', async () => {
    const { engine, stateDB, vault, remote, summary } = await absentAtClassification(noChange);
    await planOf(engine).executePlan(downloadPlan(), [remote], summary, new Map());
    expect(vault.file?.body).toBe(C1);
    expect(summary.downloadedCount).toBe(1);
    expect(retryQueueOf(engine)).not.toContain(PATH);
    expect(stateDB.getFile(PATH)!.localHash).toBe(await hashOf(C1));
  });
});

describe('[SPEC:ETG-9] a deferred conflict converges on the next sync', () => {
  it('[SPEC:ETG-9] merges the edit saved during the GET with the remote change, uploads once, then stays converged', async () => {
    const R = 'x\na\n';                            // another device prepended a line to C0
    const vault = makeVault(C1, 5_000);
    const server = await makeServer(R);
    const saveOnce = once(() => vault.save(C2, 6_000));   // the editor saves after the conflict was decided
    server.client.downloadFile.mockImplementation(async () => {
      saveOnce();
      return toBuf(server.body() ?? '');
    });
    const { engine, stateDB, bases, notify } = await buildEngine(vault.adapter, server.client, server.upload);
    await seedBaseline(stateDB, bases, C0, 1_000);

    await engine.syncSingleFile(PATH);           // sync 1: the conflict write is deferred
    expect(server.client.downloadFile).toHaveBeenCalledTimes(1);
    expect(vault.file?.body).toBe(C2);
    expect(server.upload).not.toHaveBeenCalled();
    const st = stateDB.getFile(PATH)!;
    expect(st.localMtime).toBeUndefined();
    expect(st.localSize).toBeUndefined();
    expect(st.localHash).toBe(await hashOf(C0));
    expect(notify).not.toHaveBeenCalled();

    await engine.syncSingleFile(PATH);           // sync 2: both sides changed since the baseline, so they are merged
    expect(vault.file?.body).toContain('x\n');   // the remote line ...
    expect(vault.file?.body).toContain('c\n');   // ... and the edit saved during the GET
    expect(server.upload).toHaveBeenCalledTimes(1);
    expect(dec.decode(server.upload.mock.calls[0][2])).toBe(vault.file?.body);
    expect(server.body()).toBe(vault.file?.body);
    // In watch mode the error count is only observable through the failure notice.
    expect(notify.mock.calls.filter((c) => String(c[0]).includes('Sync failed'))).toEqual([]);

    await engine.syncSingleFile(PATH);           // sync 3: converged
    expect(server.upload).toHaveBeenCalledTimes(1);
  });
});

describe('[SPEC:ETG-9] a deferral in a full sync re-arms a real scan', () => {
  const R = 'x\na\nb\n';                          // another device prepended a line to C1; its listing carries no SHA256

  // A converged one-note vault (baseline C1) on a Nextcloud double whose root ETag moved. The engine is built the way a
  // real session is (the client comes from the factory), with the vault wired to an in-memory file.
  async function fullSyncWorld() {
    const vault = makeVault(C1, 5_000);
    const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
    await stateDB.load();
    const bases = new Map<string, string>();
    const baseStore = {
      get: jest.fn((p: string) => bases.get(p)), set: jest.fn((p: string, b: string) => { bases.set(p, b); }),
      delete: jest.fn((p: string) => { bases.delete(p); }),
      requestSave: jest.fn(), flush: jest.fn(async () => undefined),
    };
    await seedBaseline(stateDB, bases, C1, 5_000);
    const settings: DavSyncSettings = { ...DEFAULT_SETTINGS, syncOnWifiOnly: false };
    stateDB.setRemoteRootEtag('ROOT-1');
    stateDB.setSyncScopeFingerprint(computeSyncScopeFingerprint(settings));

    const localAdapter = {
      ...vault.adapter,
      listVaultFiles: jest.fn(() => (vault.file ? [{ path: PATH, size: bytesLen(vault.file.body), mtime: vault.file.mtime }] : [])),
      list: jest.fn(async () => ({ files: [], folders: [] })),
      creationTimeSupport: jest.fn(async () => 'settable' as const),
      setCreationTime: jest.fn(async () => 'applied' as const),
    };
    const listing = remoteOf(R, { checksum: null, etag: 'e-moved' });
    const saveOnce = once(() => vault.save(C2, 6_000));   // the editor saves during the first GET only
    const client = {
      getRootEtag: jest.fn(async () => 'ROOT-2'),
      getFiles: jest.fn(async () => [listing]),
      getSyncToken: jest.fn(async (): Promise<string | null> => null),
      getDirectories: jest.fn(async () => []),
      remoteExists: jest.fn(async () => true),
      statFile: jest.fn(async () => listing),
      downloadFile: jest.fn(async () => { saveOnce(); return toBuf(R); }),
      uploadFile: jest.fn(async () => undefined),
      createDirectory: jest.fn(async () => undefined),
      isRemoteDirEmpty: jest.fn(async () => true),
      recalcChecksum: jest.fn(async (): Promise<string | null> => null),
      setCreationTime: jest.fn(async () => 'applied' as const),
    };
    const app = {
      vault: {
        adapter: { exists: vault.adapter.exists, mkdir: jest.fn(async () => undefined) },
        getAbstractFileByPath: () => null, getAllFolders: () => [],
      },
      fileManager: { trashFile: jest.fn(async () => undefined) },
    };
    const engine = new SyncEngine({
      app, settings, localAdapter, stateDB, baseStore,
      statusBar: new Proxy({}, { get: () => () => undefined }),
      webdavFactory: { createClient: jest.fn(async () => ({ client, features: { isNextcloud: true } })) },
      pluginDir: PLUGIN_DIR, configDir: '.obsidian', pluginsAwaitingRestart: new Set<string>(),
    } as never);
    const sync = async (): Promise<void> => { await engine.syncManual({ manual: true }); await stateDB.flush(); };
    return { vault, stateDB, client, engine, sync };
  }

  it('[SPEC:ETG-9] invalidates the root ETag when a download is deferred, and the next full sync really scans and keeps the edit', async () => {
    const { vault, stateDB, client, engine, sync } = await fullSyncWorld();

    await sync();                                 // sync 1: the scan sees the moved listing, the GET races with the save
    expect(client.getFiles).toHaveBeenCalledTimes(1);
    expect(client.downloadFile).toHaveBeenCalledTimes(1);
    expect(vault.file?.body).toBe(C2);
    expect(retryQueueOf(engine)).toContain(PATH);
    expect(stateDB.getRemoteRootEtag()).toBeNull();
    expect(engine.getLastSessionSummary()?.errorCount).toBe(0);
    expect(engine.getLastSessionSummary()?.downloadedCount).toBe(0);

    await sync();                                 // sync 2: no save; the stored ETag is null, so the scan is real
    expect(client.getFiles).toHaveBeenCalledTimes(2);
    expect(vault.file?.body).toContain('c\n');    // the edit saved during the first GET survives
    expect(vault.file?.body).toContain('x\n');    // and so does the remote change
    expect(engine.getLastSessionSummary()?.errorCount).toBe(0);
  });
});
