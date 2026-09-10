// Feature 086 (GitHub issue #46): a deletion the PLUGIN performed must never come back as a deletion
// the plugin sends to the server.
//
// The reporter lost notes from both sides. Their folder went to the local `.trash` — that part was
// already understood, and feature 081 put a server probe in front of it — and then the same notes
// turned up in Nextcloud's trashbin. The second half is a separate mechanism, and it is the one this
// file is about.
//
// Trashing a folder takes its contents with it, but the plugin only forgot the FOLDER's row. Every
// child file kept a StateDB entry, and an entry saying "synced, and now absent locally" is exactly
// what a user deletion looks like. So the next sync read the plugin's own cleanup as user intent and
// propagated it upward. A listing glitch that should have cost nothing more than a local copy became
// real, server-side data loss — an amplifier sitting between a recoverable mistake and an
// unrecoverable one.
//
// The up direction had a second, quieter hole. A tracked file absent locally AND absent from the
// listing was deleted on the server with no question asked, on the reasoning that the listing already
// proved there was nothing there to lose. This issue is the proof that a listing can be wrong about
// exactly that, so absence is no longer accepted as evidence: the path is asked about directly, and
// anything still present goes through the same checksum proof every other deletion needs.
//
// These tests drive the REAL SyncEngine over a real StateDB (in-memory DataAdapter); only the WebDAV
// client, the LocalAdapter and Obsidian's App are doubles. The bug lives in how the engine classifies
// what it sees, so a mock that re-implemented the classification would prove nothing.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import {
  DEFAULT_SETTINGS, FileState, RemoteDirInfo, RemoteFileInfo, SyncSessionSummary, NetworkError,
} from '../../../src/types';
import { sha256 } from '../../../src/util/hash';
import { TFile, TFolder } from '../support/obsidian';

const enc = new TextEncoder();
const dec = new TextDecoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
const PLUGIN_DIR = '.obsidian/plugins/nextcloud-sync';

// 1970. Far enough from both `now` and the last-sync time that the stat-signature fast-path is not
// suppressed by its safety window, so a tracked file with a matching signature reads as "locally
// unchanged" and is never queued for upload.
const BASE_MTIME = 1_000;

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

/** What the client double answers with. Mutable between syncs within one test. */
interface RemoteWorld {
  /** The full-scan file listing (`getFiles('')`). */
  listing: RemoteFileInfo[];
  /** The full-scan directory listing (`getDirectories('')`), a SEPARATE PROPFIND from the above. */
  dirs: RemoteDirInfo[];
  /** Bodies a GET returns, by path. A download whose length disagrees with the listing is refused. */
  bodies: Record<string, string>;
  /** The Depth 0 existence probe used by feature 081 (folders) and 083 (absent-locally files). */
  exists: boolean | ((path: string) => boolean);
  /** The Depth 0 stat used by the up-direction proof. `'throw'` models an unanswerable server. */
  stat: (path: string) => RemoteFileInfo | null | 'throw';
  /** What the server computes on demand when the listing carried no checksum. */
  recalc: string | null;
}

function world(over: Partial<RemoteWorld> = {}): RemoteWorld {
  return {
    listing: [], dirs: [], bodies: {}, exists: false, stat: () => null, recalc: null, ...over,
  };
}

/** A listing entry for `body` that reads as UNCHANGED against what {@link track} recorded. */
async function listed(path: string, body: string): Promise<RemoteFileInfo> {
  return {
    path, fileId: `fid-${path}`, checksum: await sha256(toBuf(body)), etag: null,
    size: enc.encode(body).length, lastModified: BASE_MTIME,
  };
}

/** A listing entry for `body` that reads as CHANGED — the server copy moved on after our base. */
async function listedAs(path: string, body: string, serverBody: string): Promise<RemoteFileInfo> {
  return {
    path, fileId: `fid-${path}`, checksum: await sha256(toBuf(serverBody)), etag: null,
    size: enc.encode(body).length, lastModified: BASE_MTIME,
  };
}

const remoteDir = (path: string): RemoteDirInfo => ({
  path, fileId: `dir-${path}`, etag: null, lastModified: BASE_MTIME,
});

/**
 * `vault` and `folders` are both live: `trashFile` mutates them, so what the NEXT scan enumerates is
 * whatever the previous one left behind rather than a fixed script.
 */
async function buildEngine(
  vault: Record<string, string>, folders: string[], w: RemoteWorld,
) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev1');
  await stateDB.load();

  // One ordered log across the client, the vault and the ignore list. Several of the properties here
  // are about ORDER, not just occurrence — an ignore registered after the trash it was meant to cover
  // protects nothing, and a DELETE issued before the probe would mean the probe decided nothing.
  const events: string[] = [];
  const sizeOf = (p: string): number => enc.encode(vault[p]).length;

  const localAdapter = {
    files: vault,
    listVaultFiles: jest.fn(() =>
      Object.keys(vault).map(p => ({ path: p, size: sizeOf(p), mtime: BASE_MTIME }))),
    list: jest.fn(async () => ({ files: [], folders: [] })), // no dot paths in these vaults
    stat: jest.fn(async (p: string) => (p in vault ? { size: sizeOf(p), mtime: BASE_MTIME } : null)),
    exists: jest.fn(async (p: string) => p in vault),
    read: jest.fn(async (p: string) => vault[p] ?? ''),
    readBinary: jest.fn(async (p: string) => toBuf(vault[p] ?? '')),
    atomicWrite: jest.fn(async (p: string, d: string) => { vault[p] = d; }),
    atomicWriteBinary: jest.fn(async (p: string, d: ArrayBuffer) => { vault[p] = dec.decode(d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { vault[p] = dec.decode(d); }),
    setMtime: jest.fn(),
    remove: jest.fn(async (p: string) => { delete vault[p]; }),
    ignore: jest.fn((p: string) => { events.push(`ignore:${p}`); }),
  };

  const client = {
    // Null every time, so no sync ever short-circuits on a matching root ETag: each one is a REAL
    // scan against whatever the world says now.
    getRootEtag: jest.fn(async (): Promise<string | null> => null),
    getFiles: jest.fn(async () => w.listing),
    getDirectories: jest.fn(async () => w.dirs),
    getSyncToken: jest.fn(async (): Promise<string | null> => null), // Nextcloud: REPORT unsupported
    remoteExists: jest.fn(async (p: string) =>
      (typeof w.exists === 'function' ? w.exists(p) : w.exists)),
    statFile: jest.fn(async (p: string): Promise<RemoteFileInfo | null> => {
      events.push(`stat:${p}`);
      const answer = w.stat(p);
      if (answer === 'throw') throw new NetworkError(503, 'service unavailable');
      return answer;
    }),
    uploadFile: jest.fn(async () => undefined),
    deleteFile: jest.fn(async (p: string) => { events.push(`delete:${p}`); }),
    createDirectory: jest.fn(async () => undefined),
    deleteCollection: jest.fn(async (p: string) => { events.push(`deleteDir:${p}`); }),
    isRemoteDirEmpty: jest.fn(async () => true),
    recalcChecksum: jest.fn(async (): Promise<string | null> => w.recalc),
    downloadFile: jest.fn(async (p: string) => toBuf(w.bodies[p] ?? '')),
  };
  // isNextcloud drives the "the server reports checksums" assumption that keeps uploads from
  // re-statting, so a stray statFile call cannot be mistaken for the deletion probe.
  const createClient = jest.fn(async () => ({ client, features: { isNextcloud: true } }));

  const trashed: string[] = [];
  let trashFails = false;
  const app = {
    vault: {
      adapter: {
        exists: jest.fn(async (p: string) => p in vault),
        remove: jest.fn(async (p: string) => { delete vault[p]; }),
        mkdir: jest.fn(async (p: string) => { if (!folders.includes(p)) folders.push(p); }),
      },
      getAbstractFileByPath: (p: string) =>
        (folders.includes(p) ? new TFolder(p) : (p in vault ? new TFile(p) : null)),
      getAllFolders: () => folders.map(p => new TFolder(p)),
    },
    fileManager: {
      // Obsidian takes the CONTENTS with the folder. That is not incidental to this feature — it is
      // the whole reason the child rows were left stranded, so the double has to do it too.
      trashFile: jest.fn(async (f: TFile | TFolder) => {
        if (trashFails) throw new Error('EACCES');
        events.push(`trash:${f.path}`);
        trashed.push(f.path);
        delete vault[f.path];
        for (const p of Object.keys(vault)) if (p.startsWith(`${f.path}/`)) delete vault[p];
        for (let i = folders.length - 1; i >= 0; i--) {
          if (folders[i] === f.path || folders[i].startsWith(`${f.path}/`)) folders.splice(i, 1);
        }
      }),
    },
  };

  const logs: string[] = [];
  const logger = { log: jest.fn(async (m: string) => { logs.push(m); }) };
  const statusBar = { setStatus: jest.fn(), setSyncComplete: jest.fn(), setProgress: jest.fn() };

  const engine = new SyncEngine({
    app, settings: { ...DEFAULT_SETTINGS, syncOnWifiOnly: false },
    localAdapter, stateDB, statusBar, webdavFactory: { createClient }, logger,
    pluginDir: PLUGIN_DIR, configDir: '.obsidian',
  } as never);

  const sync = async (): Promise<SyncSessionSummary> => {
    await engine.syncManual({ manual: true });
    await stateDB.flush(); // drain the debounced requestSave() timer
    return engine.getLastSessionSummary()!;
  };

  return {
    engine, stateDB, localAdapter, client, app, trashed, logs, events, sync, vault, folders,
    failTrash: () => { trashFails = true; },
  };
}

/**
 * Records `path` as converged: the recorded hash matches the body on disk, and the stat signature
 * matches what the vault double reports. Both matter — the signature keeps the file out of the upload
 * pass, and the hash is what every deletion decision is proved against.
 */
async function track(stateDB: StateDB, path: string, body: string): Promise<FileState> {
  const hash = await sha256(toBuf(body));
  const size = enc.encode(body).length;
  const fs: FileState = {
    path, localHash: hash, remoteId: hash, idType: 'sha256',
    size, mtime: BASE_MTIME, remoteFileId: `fid-${path}`, isConflicted: false,
    localMtime: BASE_MTIME, localSize: size, remoteMtime: BASE_MTIME,
  };
  stateDB.setFile(fs);
  return fs;
}

const trackDir = (stateDB: StateDB, path: string): void =>
  stateDB.setDir({ path, remoteFileId: `dir-${path}` });

function emptySummary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
  };
}

/**
 * The listing glitch this issue is about. The two listings are separate PROPFINDs, so the file
 * listing can be perfectly correct about `F/a.md` while the directory listing has lost `F` — and the
 * server, asked directly, agrees the folder is gone. That is what sends `F` to the local trash with
 * its contents still fully tracked.
 */
async function vaultWithTrashedFolder() {
  // `keep.md` is not decoration. Once State holds no files and there is no sync token, the next
  // session is classified as a FIRST sync and takes the initial-sync route instead — a different code
  // path from the one these tests are about. One survivor keeps every follow-up sync on the normal
  // route.
  const vault = { 'F/a.md': 'a body', 'F/sub/b.md': 'b body', 'keep.md': 'kept' };
  const w = world({
    listing: [await listed('F/a.md', 'a body'), await listed('F/sub/b.md', 'b body'),
      await listed('keep.md', 'kept')],
    dirs: [], // the directory listing lost F and F/sub; the file listing did not
    exists: (p) => p === 'keep.md', // asked directly, the server confirms both folders are gone
  });
  const h = await buildEngine(vault, ['F', 'F/sub'], w);
  await track(h.stateDB, 'F/a.md', 'a body');
  await track(h.stateDB, 'F/sub/b.md', 'b body');
  await track(h.stateDB, 'keep.md', 'kept');
  trackDir(h.stateDB, 'F');
  trackDir(h.stateDB, 'F/sub');
  return { h, w };
}

beforeEach(() => {
  // testEnvironment is 'node'; isBlockedByWifiOnly reads navigator.connection. syncOnWifiOnly=false
  // short-circuits before it, but guard the global so this environment does not throw.
  (globalThis as { navigator?: unknown }).navigator ??= {};
});

describe('GDP-8 trashing a folder forgets everything under it, not just the folder', () => {
  it('drops the child file rows and the nested directory row along with the folder', async () => {
    const { h } = await vaultWithTrashedFolder();

    await h.sync();

    expect(h.trashed).toEqual(['F/sub', 'F']); // children before parents

    // The rows are the amplifier. While they survive, the next sync sees two tracked files that are
    // absent locally — indistinguishable from the user having deleted them — and pushes that upward.
    expect(h.stateDB.getFile('F/a.md')).toBeUndefined();
    expect(h.stateDB.getFile('F/sub/b.md')).toBeUndefined();
    expect(h.stateDB.getDir('F')).toBeUndefined();
    expect(h.stateDB.getDir('F/sub')).toBeUndefined();

    // Untouched: the trash was scoped to F, and nothing else lost its tracking with it.
    expect(h.stateDB.getFile('keep.md')).toBeDefined();
    expect(h.vault['keep.md']).toBe('kept');
    expect(h.logs.join('\n')).toContain('plugin trash — dropped tracking');
  });
});

describe('GDP-9 a folder the listing was wrong about comes back, and nothing is deleted on the way', () => {
  it('downloads the surviving file again instead of deleting it from the server', async () => {
    const { h, w } = await vaultWithTrashedFolder();

    await h.sync();
    expect(h.vault['F/a.md']).toBeUndefined(); // trashed locally on the listing's word

    // The listing had lied: the server still holds F/a.md. Nothing has told this device that yet —
    // it finds out on the next scan, which is the point. Whether the vault recovers depends entirely
    // on the row having been dropped: a surviving row would make this a local deletion to propagate.
    w.dirs = [remoteDir('F')];
    w.listing = [await listed('F/a.md', 'a body'), await listed('keep.md', 'kept')];
    w.bodies = { 'F/a.md': 'a body' };

    const second = await h.sync();

    expect(h.client.deleteFile).not.toHaveBeenCalled();
    expect(h.vault['F/a.md']).toBe('a body');
    expect(h.stateDB.getFile('F/a.md')).toBeDefined();
    expect(second.downloadedCount).toBe(1);
    expect(second.errorCount).toBe(0);
  });
});

describe('GDP-10 a folder the listing was right about stays gone, quietly', () => {
  it('converges to a no-op sync with nothing left tracked under it', async () => {
    const { h, w } = await vaultWithTrashedFolder();

    await h.sync();

    w.listing = [await listed('keep.md', 'kept')];
    w.dirs = [];
    const second = await h.sync();

    expect(h.client.deleteFile).not.toHaveBeenCalled();
    expect(h.client.deleteCollection).not.toHaveBeenCalled();
    expect(second.uploadedCount).toBe(0);
    expect(second.downloadedCount).toBe(0);
    expect(second.deletedCount).toBe(0);
    expect(second.errorCount).toBe(0);
    expect(h.stateDB.getAllFiles().map(f => f.path)).toEqual(['keep.md']);
    expect(h.stateDB.getAllDirs()).toEqual([]);
  });
});

describe('GDP-11 a folder trashed because the SERVER said so forgets its subtree too', () => {
  // Driven straight at processRemoteDeletion rather than through applyRemoteMirror, which is the
  // other caller that hands it a folder. Mirror finishes by reconciling State against the remote
  // listing, and that step would drop the stranded rows on its own — so a mirror-based test would
  // pass whether or not the subtree drop existed, and prove nothing about it.
  it('drops the stale child rows the trash left behind', async () => {
    const vault = { 'F/a.md': 'a body' };
    const h = await buildEngine(vault, ['F'], world());
    await track(h.stateDB, 'F/a.md', 'a body');
    trackDir(h.stateDB, 'F');

    const summary = emptySummary();
    await (h.engine as unknown as {
      processRemoteDeletion(p: string, s: SyncSessionSummary): Promise<void>;
    }).processRemoteDeletion('F', summary);

    expect(h.trashed).toEqual(['F']);
    expect(h.vault['F/a.md']).toBeUndefined();
    expect(h.stateDB.getFile('F/a.md')).toBeUndefined();
    expect(h.stateDB.getDir('F')).toBeUndefined();
  });
});

describe('GDP-12 a trash that failed forgets nothing', () => {
  it('keeps every row so the next sync retries instead of stranding the files', async () => {
    const { h } = await vaultWithTrashedFolder();
    h.failTrash();

    const summary = await h.sync();

    // Dropping the rows here would be worse than the bug: the files are still on disk, so the sync
    // after would see two untracked local files and upload them back as new.
    expect(h.stateDB.getFile('F/a.md')).toBeDefined();
    expect(h.stateDB.getFile('F/sub/b.md')).toBeDefined();
    expect(h.stateDB.getDir('F')).toBeDefined();
    expect(h.stateDB.getDir('F/sub')).toBeDefined();
    expect(summary.errors.map(e => e.path)).toEqual(expect.arrayContaining(['F', 'F/sub']));
  });
});

describe('GDP-13 the trash is announced as the plugin\'s own before it happens', () => {
  it('registers the folder and its tracked subtree with the watcher first', async () => {
    const { h } = await vaultWithTrashedFolder();

    await h.sync();

    // Obsidian fires a vault `delete` event for the folder and for every file inside it. Watch mode
    // reads those as user deletions, so without this they would travel to the server by a completely
    // different route than the one the rest of this feature guards.
    expect(h.localAdapter.ignore).toHaveBeenCalledWith('F');
    expect(h.localAdapter.ignore).toHaveBeenCalledWith('F/a.md');
    expect(h.localAdapter.ignore).toHaveBeenCalledWith('F/sub');
    expect(h.localAdapter.ignore).toHaveBeenCalledWith('F/sub/b.md');

    // Order is the property, not the call. The events can arrive at any point once the trash starts,
    // so an ignore registered afterwards would be racing something it was supposed to prevent. Each
    // folder is checked against its OWN trash, since the two happen one after the other.
    for (const [folder, child] of [['F/sub', 'F/sub/b.md'], ['F', 'F/a.md']] as const) {
      const trashedAt = h.events.indexOf(`trash:${folder}`);
      expect(trashedAt).toBeGreaterThan(0);
      expect(h.events.indexOf(`ignore:${folder}`)).toBeLessThan(trashedAt);
      expect(h.events.indexOf(`ignore:${child}`)).toBeLessThan(trashedAt);
    }
  });
});

/**
 * A tracked file that is gone locally and missing from the listing. Before this feature that was a
 * bare DELETE; the listing was treated as proof there was nothing on the server worth keeping.
 */
async function vaultWithUnlistedMissingFile(w: Partial<RemoteWorld> = {}) {
  const h = await buildEngine({}, [], world(w));
  await track(h.stateDB, 'x.md', 'base body');
  return h;
}

describe('GDP-20 the server is asked before anything is deleted', () => {
  it('probes the exact path, and only then decides', async () => {
    // Deliberately the world where a DELETE really does follow, so the ordering has two events to
    // compare. A probe issued after the DELETE it was meant to justify would have decided nothing.
    const serverCopy = await listed('x.md', 'base body');
    const h = await vaultWithUnlistedMissingFile({ stat: () => serverCopy });

    await h.sync();

    expect(h.client.statFile).toHaveBeenCalledWith('x.md');
    expect(h.events.indexOf('stat:x.md')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('delete:x.md')).toBeGreaterThan(h.events.indexOf('stat:x.md'));
  });
});

describe('GDP-21 a path the server really does not have costs no DELETE', () => {
  it('forgets it instead, which is the same end state one round trip cheaper', async () => {
    const h = await vaultWithUnlistedMissingFile({ stat: () => null });

    const summary = await h.sync();

    expect(h.client.deleteFile).not.toHaveBeenCalled();
    expect(h.stateDB.getFile('x.md')).toBeUndefined();
    // Nothing was removed from the server, so nothing is counted as removed — as before, where the
    // DELETE threw 404 before reaching the counter.
    expect(summary.deletedCount).toBe(0);
    expect(summary.errorCount).toBe(0);
  });
});

describe('GDP-22 a path the server still holds unchanged is a real user deletion', () => {
  it('propagates it, because the checksum proves nothing was lost by doing so', async () => {
    const serverCopy = await listed('x.md', 'base body');
    const h = await vaultWithUnlistedMissingFile({ stat: () => serverCopy });

    const summary = await h.sync();

    expect(h.client.deleteFile).toHaveBeenCalledTimes(1);
    expect(h.client.deleteFile).toHaveBeenCalledWith('x.md', expect.anything());
    expect(h.stateDB.getFile('x.md')).toBeUndefined();
    expect(summary.deletedCount).toBe(1);
  });
});

describe('GDP-23 a path the server has EDITED is not a deletion at all', () => {
  it('restores the server copy rather than destroying another device\'s work', async () => {
    // The case the bare DELETE got wrong, and the reason absence is no longer accepted as proof: the
    // file was missing from the listing and very much present — and newer — on the server.
    const serverCopy = await listedAs('x.md', 'their edit', 'their edit');
    const h = await vaultWithUnlistedMissingFile({
      stat: () => serverCopy,
      bodies: { 'x.md': 'their edit' },
    });

    const summary = await h.sync();

    expect(h.client.deleteFile).not.toHaveBeenCalled();
    expect(h.vault['x.md']).toBe('their edit');
    expect(h.stateDB.getFile('x.md')).toBeDefined();
    expect(summary.downloadedCount).toBe(1);
  });
});

describe('GDP-24 a path the server cannot vouch for is left alone', () => {
  it('keeps it tracked, because absence of proof is not proof', async () => {
    const h = await vaultWithUnlistedMissingFile({
      stat: () => ({ path: 'x.md', fileId: 'fid-x.md', checksum: null, etag: null, size: 9, lastModified: 0 }),
      recalc: null, // plain WebDAV, or a checksum the server declined to compute
    });

    await h.sync();

    expect(h.client.deleteFile).not.toHaveBeenCalled();
    expect(h.stateDB.getFile('x.md')).toBeDefined();
    expect(h.logs.join('\n')).toContain('no reliable server checksum');
  });
});

describe('GDP-25 an unanswerable probe deletes nothing and is retried', () => {
  it('keeps the row rather than reading an outage as "gone"', async () => {
    const h = await vaultWithUnlistedMissingFile({ stat: () => 'throw' });

    const summary = await h.sync();

    expect(h.client.deleteFile).not.toHaveBeenCalled();
    // Dropping the row would let the next sync see the still-present remote file as new and download
    // it back, quietly undoing the deletion the user actually made.
    expect(h.stateDB.getFile('x.md')).toBeDefined();
    expect(summary.errorCount).toBe(1);
    expect(h.logs.join('\n')).toContain('probe FAILED, keeping tracking for retry');
  });
});

describe('GDP-26 a genuine local deletion still reaches the server', () => {
  it('deletes a file the listing shows unchanged and the vault no longer has', async () => {
    // The listing-present route — a different branch from GDP-22, and the one most local deletions
    // take. It has demanded a checksum since spec 023; this pins that feature 086 left it alone.
    const h = await buildEngine({ 'keep.md': 'kept' }, [], world({
      listing: [await listed('gone.md', 'gone body'), await listed('keep.md', 'kept')],
      exists: true,
    }));
    await track(h.stateDB, 'gone.md', 'gone body');
    await track(h.stateDB, 'keep.md', 'kept');

    const summary = await h.sync();

    expect(h.client.deleteFile).toHaveBeenCalledWith('gone.md', expect.anything());
    expect(h.stateDB.getFile('gone.md')).toBeUndefined();
    expect(summary.deletedCount).toBe(1);
    expect(h.stateDB.getFile('keep.md')).toBeDefined();
  });
});

describe('GDP-27 a genuine local folder deletion still reaches the server', () => {
  it('deletes the child file and then the emptied collection', async () => {
    // Everything under F is gone from the vault and from the folder list, but the server still has
    // all of it and agrees with our base. Tracked-and-absent on this side, present on that one: a
    // deletion the user made here, in both its file and folder halves.
    const h = await buildEngine({ 'keep.md': 'kept' }, [], world({
      listing: [await listed('F/a.md', 'a body'), await listed('keep.md', 'kept')],
      dirs: [remoteDir('F')],
      exists: true,
    }));
    await track(h.stateDB, 'F/a.md', 'a body');
    await track(h.stateDB, 'keep.md', 'kept');
    trackDir(h.stateDB, 'F');

    const summary = await h.sync();

    expect(h.client.deleteFile).toHaveBeenCalledWith('F/a.md', expect.anything());
    expect(h.client.deleteCollection).toHaveBeenCalledWith('F');
    expect(h.stateDB.getFile('F/a.md')).toBeUndefined();
    expect(h.stateDB.getDir('F')).toBeUndefined();
    expect(summary.errorCount).toBe(0);
  });
});

describe('GDP-28 a folder deleted on another device leaves nothing behind here', () => {
  it('settles in one sync and the next one has nothing to do', async () => {
    // The down direction, end to end: the server dropped F entirely, so the files are trashed by the
    // absence pass and the folder by directory reconciliation. What matters afterwards is that the
    // vault has genuinely converged rather than merely looking right — a leftover row would surface
    // on the very next sync as a deletion to push back up.
    const vault = { 'F/a.md': 'a body', 'keep.md': 'kept' };
    const w = world({
      listing: [await listed('keep.md', 'kept')],
      dirs: [],
      exists: (p) => p === 'keep.md',
    });
    const h = await buildEngine(vault, ['F'], w);
    await track(h.stateDB, 'F/a.md', 'a body');
    await track(h.stateDB, 'keep.md', 'kept');
    trackDir(h.stateDB, 'F');

    await h.sync();

    expect(h.trashed).toEqual(expect.arrayContaining(['F/a.md', 'F']));
    expect(h.stateDB.getFile('F/a.md')).toBeUndefined();
    expect(h.stateDB.getDir('F')).toBeUndefined();

    const second = await h.sync();

    expect(h.client.deleteFile).not.toHaveBeenCalled();
    expect(h.client.deleteCollection).not.toHaveBeenCalled();
    expect(second.uploadedCount).toBe(0);
    expect(second.downloadedCount).toBe(0);
    expect(second.deletedCount).toBe(0);
    expect(second.errorCount).toBe(0);
  });
});

describe('GDP-29 the added round trip is bounded', () => {
  it('probes each deletion candidate exactly once', async () => {
    // The cost of demanding proof: one PROPFIND per candidate, replacing the DELETE that used to go
    // out unasked. A per-candidate probe that fanned out would make large local deletions expensive
    // enough to be a regression in its own right.
    const h = await buildEngine({}, [], world({ stat: () => null }));
    await track(h.stateDB, 'one.md', 'one');
    await track(h.stateDB, 'two.md', 'two');
    await track(h.stateDB, 'three.md', 'three');

    await h.sync();

    expect(h.client.statFile).toHaveBeenCalledTimes(3);
    expect(h.events.filter(e => e.startsWith('stat:')).sort())
      .toEqual(['stat:one.md', 'stat:three.md', 'stat:two.md']);
  });
});
