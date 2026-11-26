// Direct tests for ResolutionService; only the MT-* write-time clauses are tagged here (CSS-*, UBC-* and the
// compare clauses stay with the engine-level suites). Written from the user's side: compare never mutates anything, push and pull
// reject rather than half-succeed, and a clean-side snapshot is dropped once served (it holds two full
// copies of a note, so leaking it is a storage leak).
import { ResolutionService, ResolutionDeps } from '../../../../src/sync/resolution/ResolutionService';
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import { MergeBaseRecorder } from '../../../../src/sync/session/MergeBaseRecorder';
import { TransferService } from '../../../../src/sync/transfer/TransferService';
import { FileState, RemoteFileInfo } from '../../../../src/types';
import { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import { IUploadStrategy } from '../../../../src/sync/upload/IUploadStrategy';
import { passThroughLocalWrite } from '../../support/pluginPorts';
import { spec } from '../../support/specRef';
import { sha256 } from '../../../../src/util/hash';

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
  localCtime?: number;            // creation time reported by the pre-write stat
  // Runs inside the upload mock: the user saves the file while the PUT is in flight.
  duringUpload?: (edit: (content: string, mtime: number) => void) => void;
}

function build(o: Opts = {}, over: Partial<ResolutionDeps> = {}) {
  const snaps = new Map<string, Snapshot>(Object.entries(o.snapshots ?? {}));
  let onDisk = o.localContent ?? null;
  let diskMtime = 1000;

  const calls = {
    wroteBinary: [] as string[],
    setFile: [] as FileState[],
    history: [] as string[],
    mergeBase: [] as string[],
    saved: 0,
    notices: [] as string[],
    snapWrites: [] as string[],
    snapDeletes: [] as string[],
    uploads: [] as string[],
    writeMtimes: [] as Array<number | undefined>,
    uploadMtimes: [] as Array<number | undefined>,
    uploadCtimes: [] as Array<number | undefined>,
    writeCtimes: [] as Array<number | undefined>,
    order: [] as string[],
    aligned: [] as unknown[][],
    stats: 0,
  };

  const client = {
    getFiles: async (p: string) => {
      if (o.listFails) throw new Error('PROPFIND 500');
      return o.remoteInfos ?? [remote({ path: p })];
    },
    downloadFile: async () => new TextEncoder().encode(o.remoteBody ?? 'remote body').buffer,
  } as unknown as IWebDAVClient;

  const uploadStrategy = {
    upload: async (_c: unknown, p: string, _d: unknown, mtime?: number, opts?: { ctime?: number }) => {
      calls.uploads.push(p);
      calls.uploadMtimes.push(mtime);
      calls.uploadCtimes.push(opts?.ctime);
      o.duringUpload?.((content, m) => { onDisk = content; diskMtime = m; });
      if (o.upload === 'throw') throw new Error('PUT failed');
      return o.upload === 'skipped' ? 'skipped' : 'uploaded';
    },
  } as unknown as IUploadStrategy;

  const deps: ResolutionDeps = {
    localAdapter: {
      stat: async () => {
        calls.stats++;
        return onDisk == null ? null : { size: onDisk.length, mtime: diskMtime, ctime: o.localCtime };
      },
      readBinary: async () => new TextEncoder().encode(onDisk ?? '').buffer,
      atomicWriteBinary: async (p: string, d: ArrayBuffer, mtime?: number, ctime?: number) => {
        calls.wroteBinary.push(p); calls.writeMtimes.push(mtime); calls.writeCtimes.push(ctime); onDisk = new TextDecoder().decode(d);
      },
    } as unknown as ResolutionDeps['localAdapter'],
    stateDB: {
      getFile: (p: string) => (o.conflicted?.includes(p) ? { isConflicted: true } as FileState : undefined),
      setFile: (f: FileState) => { calls.setFile.push(f); calls.order.push('setFile'); },
      save: async () => { calls.saved++; },
      countConflicted: () => o.conflicted?.length ?? 0,
    } as unknown as ResolutionDeps['stateDB'],
    localWrite: passThroughLocalWrite,
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
    expect(calls.history).toEqual(['downloaded:note.md']);
    expect(calls.setFile[0]).toMatchObject({ isConflicted: false });
  });

  it('pull: writes the body with the remote lastModified as its mtime [SPEC:MT-1]', async () => {
    const { service, client, calls } = build({
      localContent: 'old', remoteInfos: [remote({ lastModified: 1234567 })],
    });
    await service.pullRemoteToLocal(client, 'note.md');
    expect(calls.writeMtimes).toEqual([1234567]);
  });

  it('pull: passes no mtime when the remote has no lastModified', async () => {
    const { service, client, calls } = build({
      localContent: 'old', remoteInfos: [remote({ lastModified: 0 })],
    });
    await service.pullRemoteToLocal(client, 'note.md');
    expect(calls.writeMtimes).toHaveLength(1);
    expect(calls.writeMtimes[0]).toBeUndefined();
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

describe('ResolutionService.pushLocalToRemote creation time', () => {
  const T_OLD = 1690000000000;
  const T_NEW = 1700000000000;

  it(`${spec('CT-4')} sends the older of local and server creation time`, async () => {
    const { service, conn, calls } = build({ localContent: 'x', localCtime: T_NEW, remoteInfos: [remote({ creationTime: T_OLD })] });
    await service.pushLocalToRemote(conn, 'note.md');
    expect(calls.uploadCtimes).toEqual([T_OLD]);
  });

  it(`${spec('CT-4')} sends the local value when it is older than the server's`, async () => {
    const { service, conn, calls } = build({ localContent: 'x', localCtime: T_OLD, remoteInfos: [remote({ creationTime: T_NEW })] });
    await service.pushLocalToRemote(conn, 'note.md');
    expect(calls.uploadCtimes).toEqual([T_OLD]);
  });

  it(`${spec('CT-4')} sends the local value when the remote does not exist`, async () => {
    const { service, conn, calls } = build({ localContent: 'x', localCtime: T_OLD, remoteInfos: [] });
    await service.pushLocalToRemote(conn, 'note.md');
    expect(calls.uploadCtimes).toEqual([T_OLD]);
  });

  it(`${spec('CT-4')} sends no ctime when the server value is unknown`, async () => {
    const { service, conn, calls } = build({ localContent: 'x', localCtime: T_OLD, remoteInfos: [remote({ creationTime: undefined })] });
    await service.pushLocalToRemote(conn, 'note.md');
    expect(calls.uploadCtimes).toHaveLength(1);
    expect(calls.uploadCtimes[0]).toBeUndefined();
  });
});

describe('[SPEC:ETG-1] pushLocalToRemote records a pre-read signature', () => {
  const SENT = 'sent body';
  const SAVED = 'saved while the upload was in flight';

  it('records the stat taken before the read when the file is saved during the PUT', async () => {
    const { service, conn, calls } = build({ localContent: SENT, duringUpload: (edit) => edit(SAVED, 5000) });
    await service.pushLocalToRemote(conn, 'note.md');
    expect(calls.setFile).toHaveLength(1);
    expect(calls.setFile[0].localMtime).toBe(1000);
    expect(calls.setFile[0].localSize).toBe(SENT.length);
    // The saved edit is longer, so a signature taken after the PUT could not have matched.
    expect(calls.setFile[0].localSize).not.toBe(SAVED.length);
  });

  it('records the hash of the bytes it sent, not of the file after the PUT', async () => {
    const { service, conn, calls } = build({ localContent: SENT, duringUpload: (edit) => edit(SAVED, 5000) });
    await service.pushLocalToRemote(conn, 'note.md');
    const sent = await sha256(new TextEncoder().encode(SENT).buffer);
    expect(calls.setFile[0]).toMatchObject({ localHash: sent, remoteId: sent, idType: 'sha256', size: SENT.length, mtime: 1000 });
  });

  it('keeps the remote lastModified on the record', async () => {
    const { service, conn, calls } = build({ localContent: SENT, remoteInfos: [remote({ lastModified: 4321 })] });
    await service.pushLocalToRemote(conn, 'note.md');
    expect(calls.setFile[0]).toMatchObject({ localMtime: 1000, localSize: SENT.length, remoteMtime: 4321 });
  });

  it('stats the file once, before the read, and never again after the PUT', async () => {
    const { service, conn, calls } = build({ localContent: SENT });
    await service.pushLocalToRemote(conn, 'note.md');
    expect(calls.stats).toBe(1);
  });

  it('records nothing when the upload fails, so the next sync sees the unchanged baseline', async () => {
    const { service, conn, calls } = build({ localContent: SENT, upload: 'throw', duringUpload: (edit) => edit(SAVED, 5000) });
    await expect(service.pushLocalToRemote(conn, 'note.md')).rejects.toThrow(/PUT failed/);
    expect(calls.setFile).toEqual([]);
  });
});

describe('ResolutionService.pullRemoteToLocal creation time', () => {
  const T_OLD = 1690000000000;
  const T_NEW = 1700000000000;
  const withCt = (c?: number) => [remote({ creationTime: c })];

  it(`${spec('CT-2')} uses the older pre-write local ctime`, async () => {
    const { service, client, calls } = build({ localContent: 'old', localCtime: T_OLD, remoteInfos: withCt(T_NEW) });
    await service.pullRemoteToLocal(client, 'note.md');
    expect(calls.writeCtimes).toEqual([T_OLD]);
  });

  it(`${spec('CT-2')} uses the older server value when the local ctime is newer`, async () => {
    const { service, client, calls } = build({ localContent: 'old', localCtime: T_NEW, remoteInfos: withCt(T_OLD) });
    await service.pullRemoteToLocal(client, 'note.md');
    expect(calls.writeCtimes).toEqual([T_OLD]);
  });

  it(`${spec('CT-2')} uses the server value for a new download`, async () => {
    const { service, client, calls } = build({ localContent: null, remoteInfos: withCt(T_NEW) });
    await service.pullRemoteToLocal(client, 'note.md');
    expect(calls.writeCtimes).toEqual([T_NEW]);
  });

  it(`${spec('CT-2')} keeps the local ctime when the server has none`, async () => {
    const { service, client, calls } = build({ localContent: 'old', localCtime: T_OLD, remoteInfos: withCt(undefined) });
    await service.pullRemoteToLocal(client, 'note.md');
    expect(calls.writeCtimes).toEqual([T_OLD]);
  });

  it(`${spec('CT-2')} passes undefined when neither side is valid`, async () => {
    const { service, client, calls } = build({ localContent: 'old', remoteInfos: withCt(undefined) });
    await service.pullRemoteToLocal(client, 'note.md');
    expect(calls.writeCtimes).toHaveLength(1);
    expect(calls.writeCtimes[0]).toBeUndefined();
  });

  it(`${spec('CT-6')} aligns once after setFile with no third argument`, async () => {
    const { service, client, calls } = build({ localContent: 'old', remoteInfos: withCt(T_NEW) }, {
      creationTime: {
        align: async (...a: unknown[]) => { calls.order.push('align'); calls.aligned.push(a); },
      },
    });
    const info = remote({ creationTime: T_NEW });
    await service.pullRemoteToLocal(client, 'note.md');
    expect(calls.aligned).toHaveLength(1);
    expect(calls.aligned[0]).toHaveLength(2);
    expect(calls.aligned[0][0]).toBe(client);
    expect(calls.aligned[0][1]).toMatchObject({ path: info.path, creationTime: T_NEW });
    expect(calls.order).toEqual(['setFile', 'align']);
  });

  it(`${spec('CT-6')} does not throw when no aligner is wired`, async () => {
    const { service, client } = build({ localContent: 'old', remoteInfos: withCt(T_NEW) });
    await expect(service.pullRemoteToLocal(client, 'note.md')).resolves.toBeUndefined();
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

  it('applyCleanLocal: writes locally with the same mtime it uploads [SPEC:MT-5]', async () => {
    const { service, conn, calls } = build({ snapshots: { 'note.md': snap() } });
    await service.applyCleanLocal(conn, 'note.md');
    expect(calls.uploadMtimes).toHaveLength(1);
    expect(typeof calls.uploadMtimes[0]).toBe('number');
    expect(calls.writeMtimes).toEqual(calls.uploadMtimes);
  });

  it('applyCleanRemote: writes locally with the same mtime it uploads [SPEC:MT-5]', async () => {
    const { service, conn, calls } = build({ snapshots: { 'note.md': snap() } });
    await service.applyCleanRemote(conn, 'note.md');
    expect(calls.uploadMtimes).toHaveLength(1);
    expect(typeof calls.uploadMtimes[0]).toBe('number');
    expect(calls.writeMtimes).toEqual(calls.uploadMtimes);
  });

  describe('creation time', () => {
    const T_OLD = 1690000000000;
    const T_NEW = 1700000000000;
    const sn = { 'note.md': snap() };

    for (const side of ['applyCleanLocal', 'applyCleanRemote'] as const) {
      it(`${spec('CT-3')} ${side}: older local ctime wins over a newer server value`, async () => {
        const { service, conn, calls } = build({
          localContent: 'x', localCtime: T_OLD, remoteInfos: [remote({ creationTime: T_NEW })], snapshots: sn,
        });
        await service[side](conn, 'note.md');
        expect(calls.uploadCtimes).toEqual([T_OLD]);
        expect(calls.writeCtimes).toEqual([T_OLD]);
      });

      it(`${spec('CT-3')} ${side}: older server value wins over a newer local ctime`, async () => {
        const { service, conn, calls } = build({
          localContent: 'x', localCtime: T_NEW, remoteInfos: [remote({ creationTime: T_OLD })], snapshots: sn,
        });
        await service[side](conn, 'note.md');
        expect(calls.uploadCtimes).toEqual([T_OLD]);
        expect(calls.writeCtimes).toEqual([T_OLD]);
      });

      it(`${spec('CT-3')} ${side}: no remote file falls back to the local ctime`, async () => {
        const { service, conn, calls } = build({
          localContent: 'x', localCtime: T_OLD, remoteInfos: [], snapshots: sn,
        });
        await service[side](conn, 'note.md');
        expect(calls.uploadCtimes).toEqual([T_OLD]);
        expect(calls.writeCtimes).toEqual([T_OLD]);
      });

      it(`${spec('CT-3')} ${side}: no remote file and no local file leaves both ctimes undefined`, async () => {
        const { service, conn, calls } = build({ localContent: null, remoteInfos: [], snapshots: sn });
        await service[side](conn, 'note.md');
        expect(calls.uploadCtimes).toHaveLength(1);
        expect(calls.uploadCtimes[0]).toBeUndefined();
        expect(calls.writeCtimes).toHaveLength(1);
        expect(calls.writeCtimes[0]).toBeUndefined();
      });

      it(`${spec('CT-3')} ${side}: server value only is used when the local file is absent`, async () => {
        const { service, conn, calls } = build({
          localContent: null, remoteInfos: [remote({ creationTime: T_NEW })], snapshots: sn,
        });
        await service[side](conn, 'note.md');
        expect(calls.uploadCtimes).toEqual([T_NEW]);
        expect(calls.writeCtimes).toEqual([T_NEW]);
      });
    }
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

describe('[SPEC:CPS-19] pullRemoteToLocal writes through LocalWritePort', () => {
  const fakePort = () => ({ mtimeFor: jest.fn(() => 42), written: jest.fn() });

  it('writes with the mtime the port chooses and reports the write once', async () => {
    const localWrite = fakePort();
    const { service, client, calls } = build({
      localContent: 'old', remoteInfos: [remote({ lastModified: 1234567 })],
    }, { localWrite });
    await service.pullRemoteToLocal(client, 'note.md');
    expect(localWrite.mtimeFor).toHaveBeenCalledWith('note.md', 1234567);
    expect(calls.writeMtimes).toEqual([42]);
    expect(localWrite.written).toHaveBeenCalledTimes(1);
    expect(localWrite.written).toHaveBeenCalledWith('note.md');
  });

  it('passes undefined to the port when the remote has no lastModified', async () => {
    const localWrite = fakePort();
    const { service, client } = build({
      localContent: 'old', remoteInfos: [remote({ lastModified: 0 })],
    }, { localWrite });
    await service.pullRemoteToLocal(client, 'note.md');
    expect(localWrite.mtimeFor).toHaveBeenCalledWith('note.md', undefined);
  });

  it('does not report a write when the write throws', async () => {
    const localWrite = fakePort();
    const { service, client } = build({ localContent: 'old' }, {
      localWrite,
      localAdapter: {
        stat: async () => ({ size: 3, mtime: 1000 }),
        readBinary: async () => new ArrayBuffer(0),
        atomicWriteBinary: async () => { throw new Error('disk full'); },
      } as unknown as ResolutionDeps['localAdapter'],
    });
    await expect(service.pullRemoteToLocal(client, 'note.md')).rejects.toThrow('disk full');
    expect(localWrite.written).toHaveBeenCalledTimes(0);
  });
});
