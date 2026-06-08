import { SyncEngine } from '../../src/sync/SyncEngine';
import { TFile, TFolder } from 'obsidian';

/**
 * processRemoteDeletion の振る舞い契約テスト。
 * 仕様: specs/003-trash-setting-respect/contracts/remote-deletion.md (T1〜T5)
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
  // T1: 通常ノート(TFile)は trashFile で削除し、vault.trash は使わない (不変条件 C1 / FR-001)
  it('T1: TFile を解決したら fileManager.trashFile を呼び、vault.trash は呼ばない', async () => {
    // 実行時は moduleNameMapper でモックの TFile に解決される（型は実 obsidian のため as any でコンストラクタ引数を許可）。
    const file = new (TFile as unknown as new (p: string) => TFile)('Notes/a.md');
    const { run, trashFile, trash, deleteFile, summary } = makeEngine({ resolved: file });

    await run('Notes/a.md');

    expect(trashFile).toHaveBeenCalledTimes(1);
    expect(trashFile).toHaveBeenCalledWith(file);
    expect(trash).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith('Notes/a.md');
    expect(summary.downloadedCount).toBe(1);
  });

  // T2: フォルダ(TFolder)も trashFile で削除する (FR-003)
  it('T2: TFolder を解決したら fileManager.trashFile をフォルダ引数で呼ぶ', async () => {
    const folder = new (TFolder as unknown as new (p: string) => TFolder)('Notes/sub');
    const { run, trashFile, remove, deleteFile } = makeEngine({ resolved: folder });

    await run('Notes/sub');

    expect(trashFile).toHaveBeenCalledWith(folder);
    expect(remove).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith('Notes/sub');
  });

  // T3: 未追跡(null)かつ実在 → adapter.remove フォールバック (不変条件 C2 / FR-004)
  it('T3: 抽象ファイル未解決かつ実在なら adapter.remove で削除する', async () => {
    const { run, trashFile, remove, deleteFile } = makeEngine({ resolved: null, exists: true });

    await run('.obsidian/snippets/x.css');

    expect(trashFile).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('.obsidian/snippets/x.css');
    expect(deleteFile).toHaveBeenCalledWith('.obsidian/snippets/x.css');
  });

  // T4: 未追跡(null)かつ不在 → 何も削除しないが StateDB は収束 (不変条件 C4 / FR-005)
  it('T4: 既に存在しないパスは削除 API を呼ばず StateDB.deleteFile のみ行う', async () => {
    const { run, trashFile, remove, deleteFile } = makeEngine({ resolved: null, exists: false });

    await run('gone.md');

    expect(trashFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith('gone.md');
  });

  // T6 (security): 未追跡かつ traversal を含むパスは adapter.remove を呼ばない（多層防御）
  it('T6: 抽象ファイル未解決でも traversal パスは adapter.remove で削除しない', async () => {
    const { run, remove } = makeEngine({ resolved: null, exists: true });

    await run('../../etc/passwd');

    expect(remove).not.toHaveBeenCalled();
  });

  // T5: 削除失敗は例外を伝播させず、StateDB.deleteFile も呼ばない (不変条件 C3 / FR-006)
  it('T5: trashFile が失敗しても例外を伝播させず、再試行余地のため deleteFile を呼ばない', async () => {
    const file = new (TFile as unknown as new (p: string) => TFile)('Notes/b.md');
    const { run, deleteFile } = makeEngine({ resolved: file, trashRejects: true });

    await expect(run('Notes/b.md')).resolves.toBeUndefined();
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
