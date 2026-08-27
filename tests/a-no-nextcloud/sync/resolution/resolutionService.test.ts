// Direct tests for ResolutionService (feature 074, addendum).
//
// No [SPEC:...] tags: CSS-*, UBC-* and the compare clauses stay with the engine-level suites.
//
// This is everything the USER can do to settle one file, so the tests are written from that side:
// compare must never mutate anything, push and pull must reject rather than half-succeed, and a
// clean-side snapshot must be dropped once it has served its purpose (it holds two full copies of a
// note, so leaking them is a storage leak, not just untidiness).
import { ResolutionService, ResolutionDeps } from '../../../../src/sync/resolution/ResolutionService';
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import { MergeBaseRecorder } from '../../../../src/sync/session/MergeBaseRecorder';
import { TransferService } from '../../../../src/sync/transfer/TransferService';
import { FileState, RemoteFileInfo } from '../../../../src/types';
import { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import { IUploadStrategy } from '../../../../src/sync/upload/IUploadStrategy';

const remote = (over: Partial<RemoteFileInfo> = {}): RemoteFileInfo => ({
  path: 'note.md', fileId: 'fid', checksum: null, etag: '"e"', size: 11, lastModified: 2000, ...over,
});

interface Snapshot {
  local: string; remote: string;
  localMtime: number; remoteMtime: number; localSize: number; remoteSize: number;
}

interface Opts {
  localContent?: string | null;   // null ⇒ the local file does not exist
  remoteBody?: string;
  remoteInfos?: RemoteFileInfo[]; // what getFiles(path) returns
  listFails?: boolean;
  oversize?: boolean;
  upload?: 'ok' | 'skipped' | 'throw';
  snapshots?: Record<string, Snapshot>;
  conflicted?: string[];          // paths the state DB reports as conflicted
}

function build(o: Opts = {}, over: Partial<ResolutionDeps> = {}) {
  const snaps = new Map<string, Snapshot>(Object.entries(o.snapshots ?? {}));
  let onDisk = o.localContent ?? null;

  const calls = {
    wroteBinary: [] as string[],
    setMtime: [] as string[],
    setFile: [] as FileState[],
    history: [] as string[],
    mergeBase: [] as string[],
    saved: 0,
    notices: [] as string[],
    snapWrites: [] as string[],
    snapDeletes: [] as string[],
    uploads: [] as string[],
  };

  const client = {
    getFiles: async (p: string) => {
      if (o.listFails) throw new Error('PROPFIND 500');
      return o.remoteInfos ?? [remote({ path: p })];
    },
    downloadFile: async () => new TextEncoder().encode(o.remoteBody ?? 'remote body').buffer,
  } as unknown as IWebDAVClient;

  const uploadStrategy = {
    upload: async (_c: unknown, p: string) => {
      calls.uploads.push(p);
      if (o.upload === 'throw') throw new Error('PUT failed');
      return o.upload === 'skipped' ? 'skipped' : 'uploaded';
    },
  } as unknown as IUploadStrategy;

  const deps: ResolutionDeps = {
    localAdapter: {
      stat: async () => (onDisk == null ? null : { size: onDisk.length, mtime: 1000 }),
      readBinary: async () => new TextEncoder().encode(onDisk ?? '').buffer,
      atomicWriteBinary: async (p: string, d: ArrayBuffer) => {
        calls.wroteBinary.push(p); onDisk = new TextDecoder().decode(d);
      },
      setMtime: async (p: string) => { calls.setMtime.push(p); },
    } as unknown as ResolutionDeps['localAdapter'],
    stateDB: {
      getFile: (p: string) => (o.conflicted?.includes(p) ? { isConflicted: true } as FileState : undefined),
      setFile: (f: FileState) => { calls.setFile.push(f); },
      save: async () => { calls.saved++; },
      countConflicted: () => o.conflicted?.length ?? 0,
    } as unknown as ResolutionDeps['stateDB'],
    historyStore: { save: async () => { /* noop */ } } as unknown as ResolutionDeps['historyStore'],
    cleanSideStore: {
      get: (p: string) => snaps.get(p),
      set: (p: string, s: Snapshot) => { snaps.set(p, s); calls.snapWrites.push(p); },
      delete: (p: string) => { snaps.delete(p); calls.snapDeletes.push(p); },
      paths: () => [...snaps.keys()],
      requestSave: () => { /* noop */ },
    } as unknown as ResolutionDeps['cleanSideStore'],
    journal: Object.assign(new SyncJournal({}), {
      recordHistory: (p: string, op: string) => { calls.history.push(`${op}:${p}`); },
    }) as unknown as SyncJournal,
    mergeBase: {
      record: (p: string) => { calls.mergeBase.push(p); },
      drop: () => { /* noop */ },
    } as unknown as MergeBaseRecorder,
    transfer: {
      isRemoteOverSizeLimit: () => o.oversize === true,
      acquireLock: async () => null,
      releaseLock: async () => { /* noop */ },
    } as unknown as TransferService,
    autoMergeFileTypes: () => ['md'],
    maxFileSizeMB: () => 100,
    notify: (m: string) => { calls.notices.push(m); },
    ...over,
  };

  return {
    service: new ResolutionService(deps),
    client, conn: { client, uploadStrategy },
    calls, snaps,
    diskContent: () => onDisk,
  };
}

describe('ResolutionService.compareWithRemote', () => {
  it('reports both sides with a text diff for a text-eligible file', async () => {
    const { service, client } = build({ localContent: 'local body', remoteBody: 'remote body' });
    const r = await service.compareWithRemote(client, 'note.md');
    expect(r.state).toBe('ok');
    expect(r).toMatchObject({ localExists: true, remoteExists: true, diffAvailable: true });
    expect(r.localText).toBe('local body');
    expect(r.remoteText).toBe('remote body');
  });

  it('omits the text for a file type that is not auto-merge eligible', async () => {
    const { service, client } = build({ localContent: 'bytes' }, { autoMergeFileTypes: () => ['md'] });
    const r = await service.compareWithRemote(client, 'image.png');
    expect(r.localText).toBeNull();
    expect(r.remoteText).toBeNull();
    expect(r.diffAvailable).toBe(false);
    // The checksum comparison still works, which is the point of hashing bytes rather than text.
    expect(r.localChecksum).not.toBeNull();
  });

  it('decides checksumMatch from the actual bytes, not the advertised checksum', async () => {
    // Identical bytes ⇔ match ⇔ empty diff. A stale server checksum must not claim a match.
    const { service, client } = build({
      localContent: 'same', remoteBody: 'same', remoteInfos: [remote({ checksum: 'stale-and-wrong' })],
    });
    expect((await service.compareWithRemote(client, 'note.md')).checksumMatch).toBe(true);
  });

  it('reports remote-missing without an error when the remote has no such file', async () => {
    const { service, client } = build({ localContent: 'x', remoteInfos: [] });
    const r = await service.compareWithRemote(client, 'note.md');
    expect(r.state).toBe('remote-missing');
    expect(r.remoteExists).toBe(false);
    expect(r.errorMessage).toBeUndefined();
  });

  it('captures a fetch failure in the result rather than throwing', async () => {
    const { service, client } = build({ localContent: 'x', listFails: true });
    const r = await service.compareWithRemote(client, 'note.md');
    expect(r.state).toBe('error');
    expect(r.errorMessage).toContain('PROPFIND 500');
    expect(r.localExists).toBe(true); // the local side is still reported
  });

  it('shows the metadata but no diff for an oversized remote, and says why', async () => {
    // Fetching the body just to diff it can OOM on Android, so the guard stops before the GET.
    const { service, client, calls } = build({ localContent: 'x', oversize: true });
    const r = await service.compareWithRemote(client, 'note.md');
    expect(r.state).toBe('ok');
    expect(r.remoteExists).toBe(true);
    expect(r.remoteText).toBeNull();
    expect(r.diffAvailable).toBe(false);
    expect(calls.notices[0]).toContain('too large to preview');
  });

  it('handles a local file that does not exist', async () => {
    const { service, client } = build({ localContent: null });
    const r = await service.compareWithRemote(client, 'note.md');
    expect(r).toMatchObject({ localExists: false, localChecksum: null, localText: null, diffAvailable: false });
  });

  it('never writes anything', async () => {
    const { service, client, calls } = build({ localContent: 'a', remoteBody: 'b' });
    await service.compareWithRemote(client, 'note.md');
    expect(calls).toMatchObject({ wroteBinary: [], setFile: [], history: [], saved: 0 });
  });
});

describe('ResolutionService — force resolution by push / pull', () => {
  it('push: uploads the local body and converges the state DB', async () => {
    const { service, conn, calls } = build({ localContent: 'local body' });
    await service.pushLocalToRemote(conn, 'note.md');
    expect(calls.uploads).toEqual(['note.md']);
    expect(calls.history).toEqual(['uploaded:note.md']);
    expect(calls.setFile[0]).toMatchObject({ isConflicted: false, idType: 'sha256' });
    expect(calls.saved).toBe(1);
  });

  it('push: rejects when the local file is missing, recording nothing', async () => {
    const { service, conn, calls } = build({ localContent: null });
    await expect(service.pushLocalToRemote(conn, 'note.md')).rejects.toThrow(/Local file not found/);
    expect(calls.setFile).toEqual([]);
    expect(calls.history).toEqual([]);
  });

  it('push: rejects on a skipped upload rather than claiming success', async () => {
    const { service, conn, calls } = build({ localContent: 'x', upload: 'skipped' });
    await expect(service.pushLocalToRemote(conn, 'note.md')).rejects.toThrow(/size limit/);
    expect(calls.setFile).toEqual([]);
  });

  it('push: creates the remote when there is none, without a remote file id', async () => {
    const { service, conn, calls } = build({ localContent: 'x', remoteInfos: [] });
    await service.pushLocalToRemote(conn, 'note.md');
    expect(calls.setFile[0].remoteFileId).toBeNull();
  });

  it('pull: overwrites local and converges the state DB', async () => {
    const { service, client, calls, diskContent } = build({ localContent: 'old', remoteBody: 'remote body' });
    await service.pullRemoteToLocal(client, 'note.md');
    expect(diskContent()).toBe('remote body');
    expect(calls.setMtime).toEqual(['note.md']);
    expect(calls.history).toEqual(['downloaded:note.md']);
    expect(calls.setFile[0]).toMatchObject({ isConflicted: false });
  });

  it('pull: rejects when the remote has no such file', async () => {
    const { service, client, calls } = build({ remoteInfos: [] });
    await expect(service.pullRemoteToLocal(client, 'note.md')).rejects.toThrow(/Remote file not found/);
    expect(calls.wroteBinary).toEqual([]);
  });

  it('pull: refuses an oversized remote and leaves local untouched', async () => {
    const { service, client, calls, diskContent } = build({ localContent: 'keep', oversize: true });
    await expect(service.pullRemoteToLocal(client, 'note.md')).rejects.toThrow(/too large to download/);
    expect(diskContent()).toBe('keep');
    expect(calls.setFile).toEqual([]);
  });

  it('pull: prefers the server checksum as the remote id when it has one', async () => {
    const { service, client, calls } = build({
      remoteBody: 'body', remoteInfos: [remote({ checksum: 'server-sum' })],
    });
    await service.pullRemoteToLocal(client, 'note.md');
    expect(calls.setFile[0].remoteId).toBe('server-sum');
  });
});

describe('ResolutionService — clean-side snapshots', () => {
  const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
    local: 'clean local', remote: 'clean remote',
    localMtime: 100, remoteMtime: 200, localSize: 11, remoteSize: 12, ...over,
  });

  it('captures both clean sides with the metrics force-resolution later reads', async () => {
    const { service, snaps } = build();
    service.captureCleanSides('note.md', 'L', 'R', 111, 22, remote({ size: 33, lastModified: 444 }));
    expect(snaps.get('note.md')).toEqual({
      local: 'L', remote: 'R', localMtime: 111, remoteMtime: 444, localSize: 22, remoteSize: 33,
    });
  });

  it('exposes the metrics, or null when nothing was captured', async () => {
    const { service } = build({ snapshots: { 'note.md': snap() } });
    expect(service.cleanSideMetrics('note.md')).toEqual({
      localMtime: 100, remoteMtime: 200, localSize: 11, remoteSize: 12,
    });
    expect(service.cleanSideMetrics('other.md')).toBeNull();
  });

  it('drops a snapshot only when there is one to drop', async () => {
    const { service, calls } = build({ snapshots: { 'note.md': snap() } });
    service.dropCleanSnapshot('absent.md');
    expect(calls.snapDeletes).toEqual([]); // no pointless save request
    service.dropCleanSnapshot('note.md');
    expect(calls.snapDeletes).toEqual(['note.md']);
  });

  it('sweeps snapshots whose file is no longer conflicted, keeping the rest', async () => {
    // Bounded to currently-conflicted files regardless of which convergence path ran.
    const { service, calls } = build({
      snapshots: { 'still.md': snap(), 'settled.md': snap() },
      conflicted: ['still.md'],
    });
    service.sweepResolvedSnapshots();
    expect(calls.snapDeletes).toEqual(['settled.md']);
  });

  it('applyCleanLocal: writes the captured local side to BOTH sides and drops the snapshot', async () => {
    const { service, conn, calls, diskContent, snaps } = build({ snapshots: { 'note.md': snap() } });
    await service.applyCleanLocal(conn, 'note.md');
    expect(calls.uploads).toEqual(['note.md']);
    expect(diskContent()).toBe('clean local');
    expect(calls.mergeBase).toEqual(['note.md']);
    expect(snaps.has('note.md')).toBe(false);
    expect(calls.setFile[0].isConflicted).toBe(false);
  });

  it('applyCleanRemote: writes the captured remote side to both sides', async () => {
    const { service, conn, diskContent } = build({ snapshots: { 'note.md': snap() } });
    await service.applyCleanRemote(conn, 'note.md');
    expect(diskContent()).toBe('clean remote');
  });

  it('uploads BEFORE writing local, so a failed push leaves the file untouched', async () => {
    // Otherwise a failed upload would leave a "resolved-looking" local file that never reached the
    // server — a false resolution.
    const { service, conn, calls, diskContent, snaps } = build({
      localContent: 'still conflicted', snapshots: { 'note.md': snap() }, upload: 'throw',
    });
    await expect(service.applyCleanLocal(conn, 'note.md')).rejects.toThrow(/PUT failed/);
    expect(calls.wroteBinary).toEqual([]);
    expect(diskContent()).toBe('still conflicted');
    expect(snaps.has('note.md')).toBe(true); // snapshot survives for another attempt
  });

  it('falls back to push / pull when no snapshot exists', async () => {
    const push = build({ localContent: 'local now' });
    await push.service.applyCleanLocal(push.conn, 'note.md');
    expect(push.calls.history).toEqual(['uploaded:note.md']);

    const pull = build({ remoteBody: 'remote now' });
    await pull.service.applyCleanRemote(pull.conn, 'note.md');
    expect(pull.calls.history).toEqual(['downloaded:note.md']);
  });

  it('no-ops on every snapshot operation when no store is injected', async () => {
    const { service } = build({}, { cleanSideStore: undefined });
    expect(() => service.captureCleanSides('a.md', 'L', 'R', 1, 2, remote())).not.toThrow();
    expect(() => service.dropCleanSnapshot('a.md')).not.toThrow();
    expect(() => service.sweepResolvedSnapshots()).not.toThrow();
    expect(service.cleanSideMetrics('a.md')).toBeNull();
  });
});

describe('ResolutionService.getUnresolvedConflictCount', () => {
  it('reports what the state DB counts', async () => {
    const { service } = build({ conflicted: ['a.md', 'b.md'] });
    expect(await service.getUnresolvedConflictCount()).toBe(2);
  });
});
