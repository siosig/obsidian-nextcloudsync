// Feature 037 contract tests (CSF-*). Integration-style: the REAL reconcile-text + node-diff3 run
// (no mocks), so this validates true end-to-end ConflictResolver behaviour, not a stubbed merge.
import { ConflictResolver, MergeConfig, ConflictContext } from '../../../src/sync/ConflictResolver';
import { DEFAULT_SETTINGS, SyncStrategy, ConflictResolution } from '../../../src/types';
import type { App } from 'obsidian';
import type { LocalAdapter } from '../../../src/data/LocalAdapter';

function makeConfig(
  autoMergeFileStrategy: SyncStrategy = 'merge',
  otherFileStrategy: Exclude<SyncStrategy, 'merge'> = 'latest-mtime',
  autoMergeFileTypes: string[] = ['md', 'txt'],
): MergeConfig {
  return { autoMergeFileTypes, autoMergeFileStrategy, otherFileStrategy, deviceId: 'dev-abcd' };
}

function resolver(cfg: MergeConfig): ConflictResolver {
  return new ConflictResolver({} as App, {} as unknown as LocalAdapter, cfg);
}

const ctx = (over: Partial<ConflictContext> = {}): ConflictContext => ({
  localSize: 100, remoteSize: 100, localMtime: 1000, remoteMtime: 1000, ...over,
});

const NUL = String.fromCharCode(0);

describe('[SPEC:CSF-1] classification by extension', () => {
  it('[SPEC:CSF-1] extension in list → Auto Merge File; otherwise (incl. no extension) → Other File; empty list → all Other File', () => {
    const r = resolver(makeConfig('merge', 'biggest-size', ['md', 'csv']));
    expect(r.strategyFor('note.md')).toBe('merge');         // in list
    expect(r.strategyFor('data.csv')).toBe('merge');        // customizable list
    expect(r.strategyFor('image.png')).toBe('biggest-size'); // out of list
    expect(r.strategyFor('LICENSE')).toBe('biggest-size');   // no extension → Other File
    expect(resolver(makeConfig('merge', 'latest-mtime', [])).strategyFor('a.md')).toBe('latest-mtime');
  });
});

describe('[SPEC:CSF-2] merge clean → merged (real reconcile)', () => {
  it('[SPEC:CSF-2] non-overlapping edits on different lines merge into one file keeping both changes', () => {
    const r = resolver(makeConfig('merge'));
    // Distinct line edits: reconcile keeps both, no 2-line duplicate block, under the length bound.
    const d = r.decide('note.md', '', 'line1\nLOCAL\nline3', 'line1\nline3\nREMOTE');
    expect(d.action).toBe('write');
    if (d.action === 'write') {
      expect(d.clean).toBe(true);
      expect(d.content).toContain('LOCAL');
      expect(d.content).toContain('REMOTE');
    }
  });
});

describe('[SPEC:CSF-3] merge text conflict → markers', () => {
  it('[SPEC:CSF-3] diverging scalar frontmatter → semantic merge, clean resolution (feature 040)', () => {
    // Feature 040: scalar frontmatter conflicts are resolved by policy (default: remote-win).
    // k:1 vs k:2 with no ctx → remote wins → k:2. Body reconcile-merged. Result: clean.
    const r = resolver(makeConfig('merge'));
    const d = r.decide('note.md', '', '---\nk: 1\n---\nbody A', '---\nk: 2\n---\nbody B');
    expect(d.action).toBe('write');
    if (d.action === 'write') {
      expect(d.content).toContain('k: 2');
    }
  });
});

describe('[SPEC:CSF-4] merge non-text → safe-hold (FR-005a)', () => {
  it('[SPEC:CSF-4] binary content under the merge strategy is left untouched, no markers written', () => {
    const r = resolver(makeConfig('merge', 'latest-mtime', ['png']));
    expect(r.decide('image.png', '', `PNG${NUL}local`, `PNG${NUL}remote`)).toEqual({ action: 'safe-hold' });
  });
});

describe('[SPEC:CSF-6] biggest-size / [SPEC:CSF-7] latest-mtime / [SPEC:CSF-8] local|remote win', () => {
  it('[SPEC:CSF-6] biggest-size keeps the larger side', () => {
    const r = resolver(makeConfig('biggest-size', 'biggest-size'));
    expect(r.decide('image.png', '', '', '', ctx({ localSize: 500, remoteSize: 100 })).action).toBe('prefer-local');
    expect(r.decide('image.png', '', '', '', ctx({ localSize: 100, remoteSize: 500 })).action).toBe('prefer-remote');
  });

  it('[SPEC:CSF-7] latest-mtime keeps the newer side', () => {
    const r = resolver(makeConfig('latest-mtime', 'latest-mtime'));
    expect(r.decide('image.png', '', '', '', ctx({ localMtime: 5000, remoteMtime: 1000 })).action).toBe('prefer-local');
    expect(r.decide('image.png', '', '', '', ctx({ localMtime: 1000, remoteMtime: 5000 })).action).toBe('prefer-remote');
  });

  it('[SPEC:CSF-8] local-win / remote-win pick that side unconditionally', () => {
    expect(resolver(makeConfig('local-win', 'local-win')).decide('image.png', '', 'a', 'b').action).toBe('prefer-local');
    expect(resolver(makeConfig('remote-win', 'remote-win')).decide('image.png', '', 'a', 'b').action).toBe('prefer-remote');
  });
});

describe('[SPEC:CSF-9] tie → no-op success (FR-009)', () => {
  it('[SPEC:CSF-9] equal size (biggest-size) and equal mtime (latest-mtime) both yield no-op', () => {
    expect(resolver(makeConfig('biggest-size', 'biggest-size')).decide('a.png', '', '', '', ctx({ localSize: 42, remoteSize: 42 }))).toEqual({ action: 'no-op' });
    expect(resolver(makeConfig('latest-mtime', 'latest-mtime')).decide('a.png', '', '', '', ctx({ localMtime: 99, remoteMtime: 99 }))).toEqual({ action: 'no-op' });
  });
});

describe('[SPEC:CSF-10] defaults', () => {
  it('[SPEC:CSF-10] DEFAULT_SETTINGS: merge / latest-mtime / the pre-registered auto-merge types', () => {
    expect(DEFAULT_SETTINGS.autoMergeFileStrategy).toBe('merge');
    expect(DEFAULT_SETTINGS.otherFileStrategy).toBe('latest-mtime');
    expect(DEFAULT_SETTINGS.autoMergeFileTypes).toEqual(
      expect.arrayContaining(['md', 'txt']),
    );
  });
});

describe('[SPEC:CSF-13] no hold/error strategy — every conflict is decided (FR-010)', () => {
  it('[SPEC:CSF-13] decide only ever returns write / prefer-local / prefer-remote / safe-hold / no-op', () => {
    const allowed = new Set<ConflictResolution['action']>([
      'write', 'prefer-local', 'prefer-remote', 'safe-hold', 'no-op',
    ]);
    const strategies: SyncStrategy[] = ['merge', 'biggest-size', 'latest-mtime', 'local-win', 'remote-win'];
    for (const s of strategies) {
      const r = resolver(makeConfig(s, s === 'merge' ? 'latest-mtime' : s));
      const d = r.decide('note.md', '', 'a\nb', 'a\nc', ctx({ localSize: 1, remoteSize: 2 }));
      expect(allowed.has(d.action)).toBe(true);
    }
  });
});
