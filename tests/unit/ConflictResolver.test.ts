import { ConflictResolver } from '../../src/sync/ConflictResolver';
import { DavSyncSettings } from '../../src/types';
import { App, DataAdapter } from 'obsidian';

jest.mock('reconcile-text', () => ({ reconcile: (b: string, l: string, r: string) => l + r }), { virtual: true });
jest.mock('node-diff3', () => ({
  merge: (a: string[], _o: string[], b: string[]) => ({
    result: [{ conflict: { a, b } }], conflict: true,
  }),
}), { virtual: true });

function makeApp(): App {
  return { vault: { adapter: {} } } as unknown as App;
}

function makeAdapter(store: Record<string, string> = {}): DataAdapter {
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
  } as unknown as DataAdapter;
}

type Policy = DavSyncSettings['conflictFailurePolicy'];

function makeSettings(
  autoMerge = false,
  policy: Policy = 'error',
  mergeableExtensions: string[] = ['md', 'txt'],
): DavSyncSettings {
  return {
    serverUrl: '', username: '', passwordSecretId: '', syncIntervalMinutes: 0,
    networkTimeoutSeconds: 30, deviceId: 'test-dev-abcd', uploadChunkThresholdMB: 50,
    maxFileSizeMB: 1024, watchOnChangeEnabled: false,
    syncOnStartupEnabled: true, startupSyncDelaySeconds: 5, networkConcurrency: 8, syncOnWifiOnly: false,
    syncBookmarks: false, debugMode: false, chunkedUploadEnabled: true, fileLockingEnabled: false,
    autoMergeEnabled: autoMerge, maxConflictRegions: 10,
    frontmatterConflictStrategy: 'conflict',
    mergeableExtensions,
    conflictFailurePolicy: policy,
  };
}

function makeResolver(settings: DavSyncSettings, store: Record<string, string> = {}): ConflictResolver {
  const { LocalAdapter } = jest.requireActual('../../src/data/LocalAdapter') as typeof import('../../src/data/LocalAdapter');
  const adapter = new LocalAdapter(makeAdapter(store));
  return new ConflictResolver(makeApp(), adapter, settings);
}

// Frontmatter that diverges → MergeEngine refuses (strategy 'conflict') → non-clean merge.
const FM_LOCAL = '---\na: 1\n---\nbody';
const FM_REMOTE = '---\na: 2\n---\nbody';

describe('ConflictResolver helpers', () => {
  it('hasConflictMarkers detects <<<<<<< marker', () => {
    const resolver = makeResolver(makeSettings());
    expect(resolver.hasConflictMarkers('<<<<<<< LOCAL\nfoo\n=======\nbar\n>>>>>>> REMOTE\n')).toBe(true);
    expect(resolver.hasConflictMarkers('Normal content')).toBe(false);
  });

  it('stripConflictTag removes #conflict tag', () => {
    const resolver = makeResolver(makeSettings());
    const result = resolver.stripConflictTag('Content\n#conflict\n');
    expect(result).not.toContain('#conflict');
    expect(result.trim()).toBe('Content');
  });
});

describe('ConflictResolver.isMergeable', () => {
  it('matches configured extensions case-insensitively', () => {
    const r = makeResolver(makeSettings(false, 'error', ['md', 'txt']));
    expect(r.isMergeable('notes.md')).toBe(true);
    expect(r.isMergeable('NOTES.MD')).toBe(true);
    expect(r.isMergeable('memo.txt')).toBe(true);
    expect(r.isMergeable('image.png')).toBe(false);
    expect(r.isMergeable('folder/sub/note.md')).toBe(true);
  });

  it('treats files without an extension as non-mergeable', () => {
    const r = makeResolver(makeSettings());
    expect(r.isMergeable('LICENSE')).toBe(false);
    expect(r.isMergeable('archive.')).toBe(false);
    expect(r.isMergeable('.gitignore')).toBe(false); // leading-dot dotfile: name is the "ext" position guard
  });

  it('honors a customized extension list (csv added, txt removed)', () => {
    const r = makeResolver(makeSettings(false, 'error', ['md', 'csv']));
    expect(r.isMergeable('data.csv')).toBe(true);
    expect(r.isMergeable('memo.txt')).toBe(false);
  });
});

describe('ConflictResolver.decide — non-mergeable files (binary)', () => {
  it('error → skip', () => {
    const r = makeResolver(makeSettings(true, 'error'));
    expect(r.decide('image.png', '', 'a', 'b')).toEqual({ action: 'skip' });
  });
  it('local-wins → prefer-local', () => {
    const r = makeResolver(makeSettings(true, 'local-wins'));
    expect(r.decide('image.png', '', 'a', 'b')).toEqual({ action: 'prefer-local' });
  });
  it('remote-wins → prefer-remote', () => {
    const r = makeResolver(makeSettings(true, 'remote-wins'));
    expect(r.decide('image.png', '', 'a', 'b')).toEqual({ action: 'prefer-remote' });
  });
  it('conflict-markers → skip (never embed markers into binary)', () => {
    const r = makeResolver(makeSettings(true, 'conflict-markers'));
    expect(r.decide('image.png', '', 'a', 'b')).toEqual({ action: 'skip' });
  });
});

describe('ConflictResolver.decide — mergeable text, autoMerge ON', () => {
  it('clean merge → write { clean: true }', () => {
    const r = makeResolver(makeSettings(true, 'error'));
    // No frontmatter, reconcile mock returns l+r → clean.
    const d = r.decide('notes.md', '', 'local', 'remote');
    expect(d.action).toBe('write');
    if (d.action === 'write') expect(d.clean).toBe(true);
  });

  it('merge refused + error → skip', () => {
    const r = makeResolver(makeSettings(true, 'error'));
    expect(r.decide('notes.md', '', FM_LOCAL, FM_REMOTE)).toEqual({ action: 'skip' });
  });
  it('merge refused + local-wins → prefer-local', () => {
    const r = makeResolver(makeSettings(true, 'local-wins'));
    expect(r.decide('notes.md', '', FM_LOCAL, FM_REMOTE)).toEqual({ action: 'prefer-local' });
  });
  it('merge refused + remote-wins → prefer-remote', () => {
    const r = makeResolver(makeSettings(true, 'remote-wins'));
    expect(r.decide('notes.md', '', FM_LOCAL, FM_REMOTE)).toEqual({ action: 'prefer-remote' });
  });
  it('merge refused + conflict-markers → write markers { clean: false }', () => {
    const r = makeResolver(makeSettings(true, 'conflict-markers'));
    const d = r.decide('notes.md', '', FM_LOCAL, FM_REMOTE);
    expect(d.action).toBe('write');
    if (d.action === 'write') {
      expect(d.clean).toBe(false);
      expect(d.content).toContain('<<<<<<< LOCAL');
      expect(d.content).toContain('>>>>>>> REMOTE');
    }
  });
});

describe('ConflictResolver.decide — mergeable text, autoMerge OFF', () => {
  it('error → skip (no markers)', () => {
    const r = makeResolver(makeSettings(false, 'error'));
    expect(r.decide('notes.md', '', 'local', 'remote')).toEqual({ action: 'skip' });
  });
  it('conflict-markers → write full markers', () => {
    const r = makeResolver(makeSettings(false, 'conflict-markers'));
    const d = r.decide('notes.md', '', 'local content', 'remote content');
    expect(d.action).toBe('write');
    if (d.action === 'write') {
      expect(d.content).toContain('<<<<<<< LOCAL');
      expect(d.content).toContain('>>>>>>> REMOTE');
      expect(d.clean).toBe(false);
    }
  });
});

describe('ConflictResolver.resolve (local-side write)', () => {
  it('writes markers to disk for conflict-markers policy when autoMerge is OFF', async () => {
    const store: Record<string, string> = {};
    const r = makeResolver(makeSettings(false, 'conflict-markers'), store);
    const resolved = await r.resolve('notes.md', '', 'local content', 'remote content');
    expect(resolved).toBe(false);
    const written = Object.values(store).find(v => v.includes('<<<<<<<'));
    expect(written).toBeDefined();
    expect(written).toContain('<<<<<<< LOCAL');
  });

  it('does NOT write anything for the error policy (skip)', async () => {
    const store: Record<string, string> = {};
    const r = makeResolver(makeSettings(false, 'error'), store);
    const resolved = await r.resolve('notes.md', '', 'local', 'remote');
    expect(resolved).toBe(false);
    expect(Object.keys(store)).toHaveLength(0);
  });
});

describe('ConflictResolver.computeResolution (dry-run preview)', () => {
  it('skip → keeps local unchanged, clean=false', () => {
    const r = makeResolver(makeSettings(false, 'error'));
    const res = r.computeResolution('image.png', '', 'localX', 'remoteY');
    expect(res.content).toBe('localX');
    expect(res.clean).toBe(false);
  });
  it('prefer-local → after = local, clean=true', () => {
    const r = makeResolver(makeSettings(false, 'local-wins'));
    const res = r.computeResolution('image.png', '', 'localX', 'remoteY');
    expect(res.content).toBe('localX');
    expect(res.clean).toBe(true);
  });
  it('prefer-remote → after = remote, clean=true', () => {
    const r = makeResolver(makeSettings(false, 'remote-wins'));
    const res = r.computeResolution('image.png', '', 'localX', 'remoteY');
    expect(res.content).toBe('remoteY');
    expect(res.clean).toBe(true);
  });
});
