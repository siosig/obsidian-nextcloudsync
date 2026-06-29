// Layer B — conflict resolution (CF-1..13) per report/mock_test.md §3.F.
// Exercises ConflictResolver.decide() (pure, no I/O) across the feature-037 strategy matrix.
//
// Implementation reality (verified against the real libraries):
//   - ReconcileTextStrategy (primary body merge) ALWAYS returns hadConflicts:false — reconcile-text
//     force-merges without markers. So the `merge` strategy on a text file yields a clean write
//     unless the frontmatter diverges or the expansion guard fires. The CF cases assert that real
//     behaviour plus the deterministic strategies (biggest-size / latest-mtime / local|remote-win).
import { App } from 'obsidian';
import { DavSyncSettings, DEFAULT_SETTINGS } from '../../../src/types';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { ConflictResolver, MergeConfig, ConflictContext } from '../../../src/sync/ConflictResolver';

function resolver(overrides: Partial<DavSyncSettings>): ConflictResolver {
  const settings: DavSyncSettings = { ...DEFAULT_SETTINGS, deviceId: 'e2e-test-device', ...overrides };
  // decide() does not touch app/localAdapter, so minimal stand-ins are fine. Build MergeConfig the
  // same way production does (SyncEngine.handleConflict): the three per-type strategy fields.
  const config: MergeConfig = {
    autoMergeFileTypes: settings.autoMergeFileTypes,
    autoMergeFileStrategy: settings.autoMergeFileStrategy,
    otherFileStrategy: settings.otherFileStrategy,
    deviceId: settings.deviceId,
  };
  return new ConflictResolver({} as App, {} as unknown as LocalAdapter, config);
}

const ctx = (over: Partial<ConflictContext> = {}): ConflictContext => ({
  localSize: 100, remoteSize: 100, localMtime: 1000, remoteMtime: 1000, ...over,
});

// Non-overlapping edits → reconcile-text produces a clean merge.
const CLEAN = {
  base: 'line one\nline two\nline three\n',
  local: 'LOCAL one\nline two\nline three\n',
  remote: 'line one\nline two\nREMOTE three\n',
};
const DIVERGED = { base: 'base\n', local: 'local edit\n', remote: 'remote edit\n' };
const NUL = String.fromCharCode(0);

describe('Layer B — conflict resolution (CF)', () => {
  it('CF-1 merge + non-overlapping edits → clean write', () => {
    const r = resolver({ autoMergeFileStrategy: 'merge', autoMergeFileTypes: ['md'] });
    const d = r.decide('n.md', CLEAN.base, CLEAN.local, CLEAN.remote);
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(d.clean).toBe(true);
  });

  it('CF-2 other file + latest-mtime → prefers the newer side', () => {
    const r = resolver({ otherFileStrategy: 'latest-mtime', autoMergeFileTypes: ['md'] });
    expect(r.decide('n.pdf', '', '', '', ctx({ localMtime: 5000, remoteMtime: 1000 })).action).toBe('prefer-local');
  });

  it('CF-3 merge + diverging frontmatter → write markers (not clean)', () => {
    const r = resolver({ autoMergeFileStrategy: 'merge', autoMergeFileTypes: ['md'] });
    const d = r.decide('n.md', '', '---\nk: 1\n---\nbody', '---\nk: 2\n---\nbody');
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(d.clean).toBe(false);
  });

  it('CF-4 auto merge file + local-win → prefer-local', () => {
    const r = resolver({ autoMergeFileStrategy: 'local-win', autoMergeFileTypes: ['md'] });
    expect(r.decide('n.md', DIVERGED.base, DIVERGED.local, DIVERGED.remote).action).toBe('prefer-local');
  });

  it('CF-5 auto merge file + remote-win → prefer-remote', () => {
    const r = resolver({ autoMergeFileStrategy: 'remote-win', autoMergeFileTypes: ['md'] });
    expect(r.decide('n.md', DIVERGED.base, DIVERGED.local, DIVERGED.remote).action).toBe('prefer-remote');
  });

  it('CF-6 merge ON + mergeable diverging text still reaches a clean write (reconcile force-merges)', () => {
    const r = resolver({ autoMergeFileStrategy: 'merge', autoMergeFileTypes: ['md'] });
    const d = r.decide('n.md', DIVERGED.base, DIVERGED.local, DIVERGED.remote);
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(d.clean).toBe(true);
  });

  it('CF-7 merge on a non-text file → safe-hold (no markers written)', () => {
    const r = resolver({ autoMergeFileStrategy: 'merge', autoMergeFileTypes: ['png'] });
    expect(r.decide('n.png', '', `a${NUL}b`, `c${NUL}d`)).toEqual({ action: 'safe-hold' });
  });

  it('CF-8 empty auto-merge types + other=local-win → prefer-local', () => {
    const r = resolver({ autoMergeFileTypes: [], otherFileStrategy: 'local-win' });
    expect(r.decide('n.md', DIVERGED.base, DIVERGED.local, DIVERGED.remote).action).toBe('prefer-local');
  });

  // CF-9: the conflict-region cap is unit-tested in MergeEngine.test.ts with mocked strategies.
  it.skip('CF-9 conflict-region cap (covered by MergeEngine unit test with mocked strategies)', () => undefined);

  it('CF-10 biggest-size → prefers the larger side', () => {
    const r = resolver({ otherFileStrategy: 'biggest-size', autoMergeFileTypes: ['md'] });
    expect(r.decide('n.pdf', '', '', '', ctx({ localSize: 999, remoteSize: 100 })).action).toBe('prefer-local');
  });

  it('CF-11 tie (equal mtime) → no-op', () => {
    const r = resolver({ otherFileStrategy: 'latest-mtime', autoMergeFileTypes: ['md'] });
    expect(r.decide('n.pdf', '', '', '', ctx({ localMtime: 1000, remoteMtime: 1000 })).action).toBe('no-op');
  });

  // CF-12: the F4 Diff3Strategy bug was fixed in 0.7.1; verified at layer a with the real node-diff3.
  it.skip('CF-12 frontmatter conflict markers (verified at layer a; live write redundant)', () => undefined);

  // CF-13: the 412 / If-Match lost-update path is driven by SyncEngine.handleConflict (network-level).
  it.skip('CF-13 If-Match 412 → conflict (engine-level, see Layer A upload)', () => undefined);
});
