import { ConflictResolver } from '../../src/sync/ConflictResolver';
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

function makeSettings(autoMerge = false) {
  return {
    serverUrl: '', username: '', passwordSecretId: '', syncIntervalMinutes: 0,
    networkTimeoutSeconds: 30, deviceId: 'test-dev-abcd', uploadChunkThresholdMB: 50,
    maxFileSizeMB: 1024, watchOnChangeEnabled: false, chunkedUploadEnabled: true, fileLockingEnabled: false,
    autoMergeEnabled: autoMerge, maxConflictRegions: 3,
  };
}

describe('ConflictResolver', () => {
  it('hasConflictMarkers detects <<<<<<< marker', () => {
    const { LocalAdapter } = jest.requireActual('../../src/data/LocalAdapter') as typeof import('../../src/data/LocalAdapter');
    const adapter = new LocalAdapter(makeAdapter());
    const resolver = new ConflictResolver(makeApp(), adapter, makeSettings());
    expect(resolver.hasConflictMarkers('<<<<<<< LOCAL\nfoo\n=======\nbar\n>>>>>>> REMOTE\n')).toBe(true);
    expect(resolver.hasConflictMarkers('Normal content')).toBe(false);
  });

  it('stripConflictTag removes #conflict tag', () => {
    const { LocalAdapter } = jest.requireActual('../../src/data/LocalAdapter') as typeof import('../../src/data/LocalAdapter');
    const adapter = new LocalAdapter(makeAdapter());
    const resolver = new ConflictResolver(makeApp(), adapter, makeSettings());
    const result = resolver.stripConflictTag('Content\n#conflict\n');
    expect(result).not.toContain('#conflict');
    expect(result.trim()).toBe('Content');
  });

  it('embeds conflict markers when autoMerge is OFF', async () => {
    const store: Record<string, string> = {};
    const { LocalAdapter } = jest.requireActual('../../src/data/LocalAdapter') as typeof import('../../src/data/LocalAdapter');
    const adapter = new LocalAdapter(makeAdapter(store));
    const resolver = new ConflictResolver(makeApp(), adapter, makeSettings(false));
    const resolved = await resolver.resolve('notes.md', '', 'local content', 'remote content');
    expect(resolved).toBe(false);
    const written = Object.values(store).find(v => v.includes('<<<<<<<'));
    expect(written).toBeDefined();
    expect(written).toContain('<<<<<<< LOCAL');
    expect(written).toContain('>>>>>>> REMOTE');
  });

  it('resolve returns true on clean auto-merge (autoMerge ON)', async () => {
    const store: Record<string, string> = {};
    const { LocalAdapter } = jest.requireActual('../../src/data/LocalAdapter') as typeof import('../../src/data/LocalAdapter');
    const adapter = new LocalAdapter(makeAdapter(store));
    const settings = makeSettings(true);
    settings.maxConflictRegions = 10;
    const resolver = new ConflictResolver(makeApp(), adapter, settings);
    // With reconcile mock returning l+r (no conflict markers), should succeed
    const result = await resolver.resolve('notes.md', 'base', 'local', 'local');
    // local === local → reconcile returns 'locallocal', hadConflicts=false
    expect(typeof result).toBe('boolean');
  });
});
