// Spec-conformance: 017-maintenance (Vault index reset) + 010 conflict count.
// StateDB.reset / resetFile are pure (fake adapter). The first-run-after-reset and
// no-dry-run flow are SyncEngine-integration (covered by existing unit + e2e).
import { StateDB } from '../../src/data/StateDB';
import { FileState } from '../../src/types';
import { makeFakeAdapter } from './support/fakeAdapter';

function fileState(path: string, o: Partial<FileState> = {}): FileState {
  return {
    path, localHash: 'h', remoteId: 'r', idType: 'sha256', size: 1, mtime: 1,
    remoteFileId: null, isConflicted: false, ...o,
  };
}

describe('spec 017 — maintenance: Vault index reset', () => {
  it('FR-001/003: reset clears tracked files and sync token (state only), keeps deviceId', async () => {
    const d = new StateDB(makeFakeAdapter(), 'plugin', 'dev');
    d.setFile(fileState('a.md', { remoteFileId: 'f1' }));
    d.setSyncToken('token-xyz');
    await d.reset();
    expect(d.getAllFiles()).toEqual([]);
    expect(d.getSyncToken()).toBeNull();
    expect(d.getDeviceId()).toBe('dev');
  });

  it('FR-004: after reset the next load sees an empty (first-run) index', async () => {
    const a = makeFakeAdapter();
    const d = new StateDB(a, 'plugin', 'dev');
    d.setFile(fileState('a.md'));
    await d.save();
    await d.reset();
    const d2 = new StateDB(a, 'plugin', 'dev');
    await d2.load();
    expect(d2.getAllFiles()).toEqual([]);
  });

  it('FR-001: resetFile clears on-disk index without a live instance', async () => {
    const a = makeFakeAdapter();
    const seeded = new StateDB(a, 'plugin', 'dev');
    seeded.setFile(fileState('a.md'));
    await seeded.save();
    await StateDB.resetFile(a, 'plugin', 'dev');
    const reloaded = new StateDB(a, 'plugin', 'dev');
    await reloaded.load();
    expect(reloaded.getAllFiles()).toEqual([]);
  });
});

describe('spec 010 — conflict count (StateDB.countConflicted)', () => {
  it('FR-009: count reflects only files flagged isConflicted; 0 when none', () => {
    const d = new StateDB(makeFakeAdapter(), 'plugin', 'dev');
    d.setFile(fileState('a.md', { isConflicted: true }));
    d.setFile(fileState('b.md', { isConflicted: false }));
    expect(d.countConflicted()).toBe(1);
    d.setFile(fileState('a.md', { isConflicted: false }));
    expect(d.countConflicted()).toBe(0);
  });
});
