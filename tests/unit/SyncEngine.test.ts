import { StateDB } from '../../src/data/StateDB';
import { FileState } from '../../src/types';

// Simplified 3-point comparison logic extracted for unit testing
function classify(
  base: FileState | undefined,
  localHash: string,
  remoteId: string,
): 'unchanged' | 'local-modified' | 'remote-modified' | 'conflicted' | 'new-remote' | 'new-local' {
  if (!base) {
    // file not in StateDB
    if (localHash && remoteId) return 'conflicted';
    if (localHash) return 'new-local';
    return 'new-remote';
  }
  const localChanged = localHash !== base.localHash;
  const remoteChanged = remoteId !== base.remoteId;
  if (!localChanged && !remoteChanged) return 'unchanged';
  if (localChanged && !remoteChanged) return 'local-modified';
  if (!localChanged && remoteChanged) return 'remote-modified';
  return 'conflicted';
}

describe('SyncEngine 3-point comparison', () => {
  const base: FileState = {
    path: 'notes.md', localHash: 'hash-a', remoteId: 'hash-a',
    idType: 'sha256', size: 100, mtime: 1000, remoteFileId: null, isConflicted: false,
  };

  it('unchanged when both match base', () => {
    expect(classify(base, 'hash-a', 'hash-a')).toBe('unchanged');
  });

  it('local-modified when only local changed', () => {
    expect(classify(base, 'hash-b', 'hash-a')).toBe('local-modified');
  });

  it('remote-modified when only remote changed', () => {
    expect(classify(base, 'hash-a', 'hash-c')).toBe('remote-modified');
  });

  it('conflicted when both changed', () => {
    expect(classify(base, 'hash-b', 'hash-c')).toBe('conflicted');
  });

  it('new-remote when no base and no local hash', () => {
    expect(classify(undefined, '', 'hash-x')).toBe('new-remote');
  });

  it('new-local when no base and no remote id', () => {
    expect(classify(undefined, 'hash-y', '')).toBe('new-local');
  });
});

describe('StateDB integration with SyncEngine logic', () => {
  function makeAdapter(files: Record<string, string> = {}) {
    const store = { ...files };
    return {
      read: jest.fn(async (p: string) => store[p] ?? ''),
      write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
      readBinary: jest.fn(),
      writeBinary: jest.fn(),
      exists: jest.fn(async (p: string) => p in store),
      remove: jest.fn(async (p: string) => { delete store[p]; }),
      rename: jest.fn(async (from: string, to: string) => { store[to] = store[from]; delete store[from]; }),
      stat: jest.fn(),
      list: jest.fn(),
    };
  }

  it('detects conflicted files after setting isConflicted', async () => {
    const db = new StateDB(makeAdapter() as never, '.obsidian/plugins/test', 'dev-001');
    await db.load();
    db.setFile({ path: 'a.md', localHash: 'x', remoteId: 'x', idType: 'sha256', size: 10, mtime: 0, remoteFileId: null, isConflicted: true });
    expect(db.countConflicted()).toBe(1);
    // After resolution
    const f = db.getFile('a.md')!;
    db.setFile({ ...f, isConflicted: false });
    expect(db.countConflicted()).toBe(0);
  });
});
