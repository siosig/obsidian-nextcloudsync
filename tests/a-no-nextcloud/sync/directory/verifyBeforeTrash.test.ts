// [SPEC:DTV-1] [SPEC:DTV-2] A local folder is never trashed on the strength of a listing alone
// (feature 081, GitHub issue #46).
//
// The report: create a subfolder in Obsidian, watch it reach the server, and moments later watch it
// and everything in it move to `.trash`. The path that does this is short. Watch mode records the
// folder as "on the server" the instant its MKCOL returns; the next full sync then reads a folder
// that is on disk, recorded, and absent from the remote listing as "deleted remotely" and trashes it
// with its contents. One folder is one deletion, so the mass-delete breaker — built to catch a
// listing that is wrong about MANY folders — does not fire.
//
// File deletions already refuse to act without proof: applyLocalDeletion needs the server checksum
// to match the base before it deletes anything. Folders had no such guard. This adds one: before a
// tracked local folder is trashed, the server is asked directly (PROPFIND Depth 0) whether it is
// really gone. A listing that omits a folder is a reason to look, not a reason to delete.
//
// Why the listing was wrong in the reporter's case is not yet known and is deliberately not part of
// this fix: whatever the cause, "absent from the listing → delete" is the step that destroys data.
import { DirectoryReconciler, DirectoryDeps } from '../../../../src/sync/directory/DirectoryReconciler';
import { SyncJournal } from '../../../../src/sync/session/SyncJournal';
import { TransferService } from '../../../../src/sync/transfer/TransferService';
import { SyncSessionSummary, DirState } from '../../../../src/types';
import { IWebDAVClient } from '../../../../src/network/IWebDAVClient';
import { TFolder } from '../../support/obsidian';

const summary = (): SyncSessionSummary => ({
  startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
  mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
});

/**
 * A vault with one tracked folder that the remote listing does NOT mention — the exact state issue
 * #46 arrives in. `exists` is what the server says when asked directly.
 */
function build(exists: boolean | (() => Promise<boolean>)) {
  const calls = { trash: [] as string[], deleteDir: [] as string[], remoteExists: [] as string[] };
  const logs: string[] = [];
  const client = {
    getDirectories: async () => [],           // the listing omits 'Projects/New'
    createDirectory: async () => undefined,
    deleteCollection: async () => undefined,
    isRemoteDirEmpty: async () => true,
    remoteExists: async (p: string) => {
      calls.remoteExists.push(p);
      return typeof exists === 'function' ? exists() : exists;
    },
  } as unknown as IWebDAVClient;

  const deps: DirectoryDeps = {
    app: {
      vault: {
        adapter: { mkdir: async () => undefined },
        getAllFolders: () => [new TFolder('Projects/New')],
        getAbstractFileByPath: (p: string) => (p === 'Projects/New' ? new TFolder(p) : null),
      },
      fileManager: { trashFile: async (f: TFolder) => { calls.trash.push(f.path); } },
    } as unknown as DirectoryDeps['app'],
    stateDB: {
      getAllDirs: (): DirState[] => [{ path: 'Projects/New', remoteFileId: null }],
      setDir: () => undefined,
      deleteDir: (p: string) => { calls.deleteDir.push(p); },
      requestSave: () => undefined,
    } as unknown as DirectoryDeps['stateDB'],
    journal: new SyncJournal({}),
    transfer: {
      acquireLock: async () => null, releaseLock: async () => undefined,
    } as unknown as TransferService,
    isSystemExcluded: () => false,
    massDeleteLimit: () => -1,
    isCancelled: () => false,
    logger: { log: async (m: string) => { logs.push(m); } },
  };
  return { reconciler: new DirectoryReconciler(deps), client, calls, logs };
}

describe('[SPEC:DTV-1] a folder missing from the listing but present on the server is kept', () => {
  it('does not trash it, does not drop its tracking, and says why in the log', async () => {
    const { reconciler, client, calls, logs } = build(true);
    await reconciler.reconcileDirectories(client, summary());

    expect(calls.trash).toEqual([]);
    expect(calls.deleteDir).toEqual([]);
    expect(calls.remoteExists).toEqual(['Projects/New']);
    expect(logs.join('\n')).toMatch(/Projects\/New/);
  });

  it('keeps it when the server cannot be asked at all', async () => {
    // No answer is not the same as "gone". The file-side rule is the same: without proof, do not
    // delete. NextcloudClient.remoteExists already resolves errors to `true`; this covers a client
    // that rejects instead.
    const { reconciler, client, calls } = build(async () => { throw new Error('offline'); });
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.trash).toEqual([]);
    expect(calls.deleteDir).toEqual([]);
  });
});

describe('[SPEC:DTV-2] the guard does not silence genuine remote deletions', () => {
  it('still trashes a folder the server confirms is gone', async () => {
    // The over-correction to avoid: a guard that keeps every folder would leave a deletion made on
    // another device stranded on this one forever. A definitive 404 is proof, and it acts on it.
    const { reconciler, client, calls } = build(false);
    const s = summary();
    await reconciler.reconcileDirectories(client, s);

    expect(calls.trash).toEqual(['Projects/New']);
    expect(calls.deleteDir).toEqual(['Projects/New']);
    // deletedCount is not asserted: the local-trash branch has never counted itself there (only the
    // remote-delete branch does), and changing that is not this fix's business.
  });

  it('asks the server once per candidate, and not at all when there is nothing to trash', async () => {
    const { reconciler, client, calls } = build(false);
    (client as unknown as { getDirectories: () => Promise<unknown[]> }).getDirectories =
      async () => [{ path: 'Projects/New', fileId: null, etag: null, lastModified: 0 }]; // present
    await reconciler.reconcileDirectories(client, summary());
    expect(calls.remoteExists).toEqual([]); // L && R: nothing to verify, nothing to pay for
  });
});
