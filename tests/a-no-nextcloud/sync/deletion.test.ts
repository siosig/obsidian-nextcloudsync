import { SyncEngine } from '../../../src/sync/SyncEngine';
import { TFile, TFolder } from 'obsidian';

/**
 * Behavior contract tests for processRemoteDeletion.
 * Spec: specs/003-trash-setting-respect/contracts/remote-deletion.md (T1-T5)
 */
function makeEngine(opts?: { resolved?: unknown; exists?: boolean; trashRejects?: boolean }) {
  const trashFile = jest.fn(() =>
    opts?.trashRejects ? Promise.reject(new Error('boom')) : Promise.resolve(),
  );
  const trash = jest.fn().mockResolvedValue(undefined);
  const remove = jest.fn().mockResolvedValue(undefined);
  const exists = jest.fn().mockResolvedValue(opts?.exists ?? false);
  const getAbstractFileByPath = jest.fn().mockReturnValue(opts?.resolved ?? null);
  const deleteFile = jest.fn();

  const app = {
    vault: { adapter: { exists, remove }, getAbstractFileByPath, trash },
    fileManager: { trashFile },
  };
  const engine = new SyncEngine({ app, stateDB: { deleteFile } } as never);
  const summary = { downloadedCount: 0 } as { downloadedCount: number };

  const run = (path: string) =>
    (engine as unknown as {
      processRemoteDeletion(p: string, s: unknown): Promise<void>;
    }).processRemoteDeletion(path, summary);

  return { run, trashFile, trash, remove, exists, getAbstractFileByPath, deleteFile, summary };
}

describe('SyncEngine.processRemoteDeletion', () => {
  // T1: a normal note (TFile) is removed via trashFile, not vault.trash (invariant C1 / FR-001)
  it('T1: resolving a TFile calls fileManager.trashFile and never vault.trash', async () => {
    // At runtime moduleNameMapper resolves this to the mocked TFile (the type is the real obsidian one, so `as any` allows the constructor argument).
    const file = new (TFile as unknown as new (p: string) => TFile)('Notes/a.md');
    const { run, trashFile, trash, deleteFile, summary } = makeEngine({ resolved: file });

    await run('Notes/a.md');

    expect(trashFile).toHaveBeenCalledTimes(1);
    expect(trashFile).toHaveBeenCalledWith(file);
    expect(trash).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith('Notes/a.md');
    expect(summary.downloadedCount).toBe(1);
  });

  // T2: a folder (TFolder) is also removed via trashFile (FR-003)
  it('T2: resolving a TFolder calls fileManager.trashFile with the folder', async () => {
    const folder = new (TFolder as unknown as new (p: string) => TFolder)('Notes/sub');
    const { run, trashFile, remove, deleteFile } = makeEngine({ resolved: folder });

    await run('Notes/sub');

    expect(trashFile).toHaveBeenCalledWith(folder);
    expect(remove).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith('Notes/sub');
  });

  // T3: untracked (null) but present on disk -> adapter.remove fallback (invariant C2 / FR-004)
  it('T3: an unresolved abstract file that exists is removed via adapter.remove', async () => {
    const { run, trashFile, remove, deleteFile } = makeEngine({ resolved: null, exists: true });

    await run('.obsidian/snippets/x.css');

    expect(trashFile).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('.obsidian/snippets/x.css');
    expect(deleteFile).toHaveBeenCalledWith('.obsidian/snippets/x.css');
  });

  // T4: untracked (null) and absent -> delete nothing, but StateDB still converges (invariant C4 / FR-005)
  it('T4: an already-missing path calls no delete API and only StateDB.deleteFile', async () => {
    const { run, trashFile, remove, deleteFile } = makeEngine({ resolved: null, exists: false });

    await run('gone.md');

    expect(trashFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith('gone.md');
  });

  // T6 (security): an untracked path containing traversal must not reach adapter.remove (defense in depth)
  it('T6: an unresolved abstract file with a traversal path is not removed via adapter.remove', async () => {
    const { run, remove } = makeEngine({ resolved: null, exists: true });

    await run('../../etc/passwd');

    expect(remove).not.toHaveBeenCalled();
  });

  // T5: a delete failure does not propagate and does not call StateDB.deleteFile (invariant C3 / FR-006)
  it('T5: when trashFile fails, the error is not propagated and deleteFile is not called (leaving room for retry)', async () => {
    const file = new (TFile as unknown as new (p: string) => TFile)('Notes/b.md');
    const { run, deleteFile } = makeEngine({ resolved: file, trashRejects: true });

    await expect(run('Notes/b.md')).resolves.toBeUndefined();
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
