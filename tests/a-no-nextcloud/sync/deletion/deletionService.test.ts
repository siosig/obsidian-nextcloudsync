// Direct tests for DeletionService (feature 074, addendum).
//
// No [SPEC:...] tags: DEL-*, SG-* and MDV-* stay with the engine-level suites.
//
// Both directions can destroy data if they decide wrong, so both are written as "what has to be true
// before anything is removed".
//
// Outbound: a local deletion is propagated ONLY on a real content hash proving the server copy never
// diverged. An etag or a size is not proof, and the code declines rather than guessing.
//
// Inbound: the scope guard is a security boundary. A compromised server can fabricate a deletion for
// `.obsidian/...`, and that check is the only thing between it and a raw filesystem remove.
import { DeletionService, DeletionDeps } from '../../../../src/sync/deletion/DeletionService';
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import { MergeBaseRecorder } from '../../../../src/sync/session/MergeBaseRecorder';
import { TransferService } from '../../../../src/sync/transfer/TransferService';
import { FileState, RemoteFileInfo, SyncSessionSummary, NetworkError } from '../../../../src/types';
import { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import { TFile, TFolder, Notice } from '../../support/obsidian';

function summary(): SyncSessionSummary {
  return {
    startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
    mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
  };
}

const remote = (over: Partial<RemoteFileInfo> = {}): RemoteFileInfo => ({
  path: 'note.md', fileId: 'fid', checksum: null, etag: '"e"', size: 10, lastModified: 2000, ...over,
});

const base = (over: Partial<FileState> = {}): FileState => ({
  path: 'note.md', localHash: 'BASE-HASH', remoteId: 'r', idType: 'etag', size: 10, mtime: 1000,
  remoteFileId: 'fid', isConflicted: false, ...over,
});

interface Opts {
  /** What recalcChecksum returns; 'throw' makes it fail. */
  recalc?: string | null | 'throw';
  /** Vault-tracked abstract files, by path. */
  vaultFiles?: Record<string, 'file' | 'folder'>;
  /** Paths adapter.exists() reports. */
  adapterPaths?: string[];
  deleteFails?: number | 'error';
  trashFails?: boolean;
  excluded?: (path: string) => boolean;
}

function build(o: Opts = {}, over: Partial<DeletionDeps> = {}) {
  const calls = {
    remoteDeletes: [] as string[],
    trashed: [] as string[],
    adapterRemoved: [] as string[],
    stateDeletes: [] as string[],
    droppedBase: [] as string[],
    history: [] as string[],
    downloads: [] as string[],
  };

  const client = {
    recalcChecksum: async () => {
      if (o.recalc === 'throw') throw new Error('unsupported');
      return o.recalc ?? null;
    },
    deleteFile: async (p: string) => {
      if (o.deleteFails === 'error') throw new Error('boom');
      if (typeof o.deleteFails === 'number') throw new NetworkError(o.deleteFails, '');
      calls.remoteDeletes.push(p);
    },
  } as unknown as IWebDAVClient;

  const deps: DeletionDeps = {
    app: {
      vault: {
        getAbstractFileByPath: (p: string) => {
          const kind = o.vaultFiles?.[p];
          if (kind === 'file') return new TFile(p);
          if (kind === 'folder') return new TFolder(p);
          return null;
        },
        adapter: {
          exists: async (p: string) => o.adapterPaths?.includes(p) === true,
          remove: async (p: string) => { calls.adapterRemoved.push(p); },
        },
      },
      fileManager: {
        trashFile: async (f: TFile | TFolder) => {
          if (o.trashFails) throw new Error('EACCES');
          calls.trashed.push(f.path);
        },
      },
    } as unknown as DeletionDeps['app'],
    stateDB: { deleteFile: (p: string) => { calls.stateDeletes.push(p); } } as unknown as DeletionDeps['stateDB'],
    journal: Object.assign(new SyncJournal({}), {
      recordHistory: (p: string, op: string) => { calls.history.push(`${op}:${p}`); },
    }) as unknown as SyncJournal,
    mergeBase: {
      record: () => { /* noop */ },
      drop: (p: string) => { calls.droppedBase.push(p); },
    } as unknown as MergeBaseRecorder,
    transfer: {
      downloadFile: async (_c: unknown, r: RemoteFileInfo) => { calls.downloads.push(r.path); },
    } as unknown as TransferService,
    isSystemExcluded: o.excluded ?? (() => false),
    ...over,
  };

  return { deletion: new DeletionService(deps), client, calls };
}

describe('DeletionService.applyLocalDeletion — proof before propagation', () => {
  it('deletes on the server when the recomputed checksum matches our base', async () => {
    const { deletion, client, calls } = build({ recalc: 'BASE-HASH' });
    const s = summary();
    await deletion.applyLocalDeletion(client, remote(), base(), 'rid', 'etag', s);
    expect(calls.remoteDeletes).toEqual(['note.md']);
    expect(s.deletedCount).toBe(1);
    expect(calls.history).toEqual(['deleted:note.md']);
    expect(calls.stateDeletes).toEqual(['note.md']);
    expect(calls.droppedBase).toEqual(['note.md']);
  });

  it('uses the checksum the listing already carried instead of asking again', async () => {
    let asked = 0;
    const { deletion, client, calls } = build({}, {});
    (client as unknown as { recalcChecksum: () => Promise<string> }).recalcChecksum =
      async () => { asked++; return 'BASE-HASH'; };
    await deletion.applyLocalDeletion(client, remote({ checksum: 'BASE-HASH' }), base(), 'rid', 'etag', summary());
    expect(asked).toBe(0);
    expect(calls.remoteDeletes).toEqual(['note.md']);
  });

  it('RESTORES the remote copy when it diverged from our base', async () => {
    // Someone else edited the file after our last sync. Deleting it would discard their edit.
    const { deletion, client, calls } = build({ recalc: 'SOMEONE-ELSE-EDITED' });
    await deletion.applyLocalDeletion(client, remote(), base(), 'rid', 'etag', summary());
    expect(calls.remoteDeletes).toEqual([]);
    expect(calls.downloads).toEqual(['note.md']);
    expect(calls.stateDeletes).toEqual([]);
  });

  it('does NOTHING when the server cannot produce a checksum', async () => {
    // A plain WebDAV server, or a failed recalc. The etag and size are not proof of unchanged
    // content, so deleting here could discard a remote edit. The deletion still propagates via the
    // incremental token path later.
    for (const recalc of [null, 'throw' as const]) {
      const { deletion, client, calls } = build({ recalc });
      await deletion.applyLocalDeletion(client, remote(), base(), 'rid', 'etag', summary());
      expect(calls.remoteDeletes).toEqual([]);
      expect(calls.downloads).toEqual([]);
      expect(calls.stateDeletes).toEqual([]); // still tracked — nothing was decided
    }
  });

  it('treats a 404 as the desired end state', async () => {
    const { deletion, client, calls } = build({ recalc: 'BASE-HASH', deleteFails: 404 });
    await deletion.applyLocalDeletion(client, remote(), base(), 'rid', 'etag', summary());
    expect(calls.stateDeletes).toEqual(['note.md']); // already gone remotely ⇒ stop tracking
    expect(calls.droppedBase).toEqual(['note.md']);
  });

  it('propagates any other delete failure instead of dropping the entry', async () => {
    // G1-2: keeping the state entry is what makes the next sync retry rather than re-download.
    const { deletion, client, calls } = build({ recalc: 'BASE-HASH', deleteFails: 500 });
    await expect(
      deletion.applyLocalDeletion(client, remote(), base(), 'rid', 'etag', summary()),
    ).rejects.toThrow();
    expect(calls.stateDeletes).toEqual([]);
  });
});

describe('DeletionService.processRemoteDeletion — the scope guard', () => {
  beforeEach(() => { Notice.instances = []; });

  it('ignores a server-reported deletion for a path outside sync scope', async () => {
    // A compromised server fabricating a deletion for the config folder must not reach the raw fs
    // remove below. This check is the boundary.
    const { deletion, calls } = build({
      excluded: (p) => p.startsWith('.obsidian/'),
      adapterPaths: ['.obsidian/plugins/other/main.js'],
    });
    await deletion.processRemoteDeletion('.obsidian/plugins/other/main.js', summary());
    expect(calls.adapterRemoved).toEqual([]);
    expect(calls.trashed).toEqual([]);
    expect(calls.stateDeletes).toEqual([]);
  });

  it('refuses a path that escapes the vault even when it is in scope', async () => {
    // Defense in depth: the boundary guard above should already have caught it.
    const { deletion, calls } = build({ adapterPaths: ['../outside.md', '/etc/passwd'] });
    await deletion.processRemoteDeletion('../outside.md', summary());
    await deletion.processRemoteDeletion('/etc/passwd', summary());
    expect(calls.adapterRemoved).toEqual([]);
  });
});

describe('DeletionService.processRemoteDeletion — applying it locally', () => {
  beforeEach(() => { Notice.instances = []; });

  it('routes a vault-tracked file through the user\'s own deletion setting', async () => {
    const { deletion, calls } = build({ vaultFiles: { 'note.md': 'file' } });
    const s = summary();
    await deletion.processRemoteDeletion('note.md', s);
    expect(calls.trashed).toEqual(['note.md']);
    expect(calls.adapterRemoved).toEqual([]); // never a raw remove for tracked content
    expect(s.downloadedCount).toBe(1);
    expect(calls.history).toEqual(['deleted:note.md']);
    expect(calls.stateDeletes).toEqual(['note.md']);
    expect(calls.droppedBase).toEqual(['note.md']);
  });

  it('handles a folder the same way', async () => {
    const { deletion, calls } = build({ vaultFiles: { Folder: 'folder' } });
    await deletion.processRemoteDeletion('Folder', summary());
    expect(calls.trashed).toEqual(['Folder']);
  });

  it('removes a config dotfile directly, since the vault does not track it', async () => {
    const { deletion, calls } = build({ adapterPaths: ['.obsidian/bookmarks.json'] });
    await deletion.processRemoteDeletion('.obsidian/bookmarks.json', summary());
    expect(calls.adapterRemoved).toEqual(['.obsidian/bookmarks.json']);
    expect(calls.stateDeletes).toEqual(['.obsidian/bookmarks.json']);
  });

  it('still cleans up state for a file that is already gone locally', async () => {
    const { deletion, calls } = build({ vaultFiles: {}, adapterPaths: [] });
    const s = summary();
    await deletion.processRemoteDeletion('note.md', s);
    expect(calls.trashed).toEqual([]);
    expect(calls.adapterRemoved).toEqual([]);
    expect(s.downloadedCount).toBe(0); // nothing was deleted, so nothing is counted
    expect(calls.stateDeletes).toEqual(['note.md']); // but tracking is dropped
  });

  it('keeps the state entry when the deletion fails, so the next sync retries', async () => {
    const { deletion, calls } = build({ vaultFiles: { 'note.md': 'file' }, trashFails: true });
    await deletion.processRemoteDeletion('note.md', summary());
    expect(calls.stateDeletes).toEqual([]);
    expect(calls.droppedBase).toEqual([]);
    expect(Notice.instances).toHaveLength(1); // and the user is told
  });

  it('does not abort the session for one failed deletion', async () => {
    const { deletion } = build({ vaultFiles: { 'note.md': 'file' }, trashFails: true });
    await expect(deletion.processRemoteDeletion('note.md', summary())).resolves.toBeUndefined();
  });
});
