import { SyncEngine } from '../../src/sync/SyncEngine';
import { FileState } from '../../src/types';
import { SIGNATURE_SAFETY_WINDOW_MS } from '../../src/util/limits';

/**
 * Tests the P0-A local-unchanged fast-path (`isLocallyUnchanged`): the stat-signature change
 * detection that works on mobile (where setMtime is a no-op). Exercises the private method through
 * a minimal engine instance, with a stubbed stateDB.getLastSyncTime().
 */
function makeEngine(lastSyncTime = 0) {
  const opts = {
    app: {}, settings: {},
    localAdapter: {},
    stateDB: { getLastSyncTime: () => lastSyncTime },
    statusBar: {}, webdavFactory: {}, pluginDir: '', configDir: '.obsidian',
  };
  const engine = new SyncEngine(opts as never);
  return (base: FileState, stat: { mtime: number; size: number }) =>
    (engine as unknown as {
      isLocallyUnchanged(b: FileState, s: { mtime: number; size: number }): boolean;
    }).isLocallyUnchanged(base, stat);
}

function baseWithSignature(over: Partial<FileState> = {}): FileState {
  return {
    path: 'n.md', localHash: 'h', remoteId: 'r', idType: 'sha256',
    size: 100, mtime: 1_000_000, remoteFileId: 'fid', isConflicted: false,
    localMtime: 1_000_000, localSize: 100, remoteMtime: 1_000_000,
    ...over,
  };
}

describe('SyncEngine.isLocallyUnchanged (P0-A stat-signature fast-path)', () => {
  // An old-but-stable mtime, far from "now" and far from lastSync, so the safety window never fires.
  const OLD = 1_000_000;

  it('treats a matching signature as unchanged (no hash needed)', () => {
    const isUnchanged = makeEngine(0);
    expect(isUnchanged(baseWithSignature({ localMtime: OLD, localSize: 100 }), { mtime: OLD, size: 100 })).toBe(true);
  });

  it('detects a size change', () => {
    const isUnchanged = makeEngine(0);
    expect(isUnchanged(baseWithSignature({ localMtime: OLD, localSize: 100 }), { mtime: OLD, size: 101 })).toBe(false);
  });

  it('detects an mtime change', () => {
    const isUnchanged = makeEngine(0);
    expect(isUnchanged(baseWithSignature({ localMtime: OLD, localSize: 100 }), { mtime: OLD + 10_000, size: 100 })).toBe(false);
  });

  it('forces a hash when the signature is absent (migrated/old state)', () => {
    const isUnchanged = makeEngine(0);
    const base = baseWithSignature({ localMtime: undefined, localSize: undefined });
    expect(isUnchanged(base, { mtime: OLD, size: 100 })).toBe(false);
  });

  it('forces a hash within the safety window of "now" (same-size edit guard)', () => {
    const isUnchanged = makeEngine(0);
    const now = Date.now();
    // File touched right now, signature matches → must still hash (mtime granularity could hide a same-size edit).
    expect(isUnchanged(baseWithSignature({ localMtime: now, localSize: 100 }), { mtime: now, size: 100 })).toBe(false);
  });

  it('forces a hash within the safety window of the last sync completion', () => {
    const lastSync = 5_000_000;
    const isUnchanged = makeEngine(lastSync);
    const mtime = lastSync + Math.floor(SIGNATURE_SAFETY_WINDOW_MS / 2); // within window of lastSync
    expect(isUnchanged(baseWithSignature({ localMtime: mtime, localSize: 100 }), { mtime, size: 100 })).toBe(false);
  });

  it('stays on the fast-path when mtime is just outside the safety window of the last sync', () => {
    const lastSync = 5_000_000;
    const isUnchanged = makeEngine(lastSync);
    const mtime = lastSync - SIGNATURE_SAFETY_WINDOW_MS - 1; // outside the window
    expect(isUnchanged(baseWithSignature({ localMtime: mtime, localSize: 100 }), { mtime, size: 100 })).toBe(true);
  });
});
