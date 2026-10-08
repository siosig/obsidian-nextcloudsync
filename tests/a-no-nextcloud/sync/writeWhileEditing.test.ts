// [SPEC:WOV-2] Never write to a file the user is typing into (GitHub issue #42; docs/spec.md §5.7b).
// Serializing watch cycles removes spurious conflicts but does not make writing under the cursor safe: a
// GENUINE conflict still resolves by writing a merged body to disk, and if that lands mid-sentence the user
// watches their own text rearrange.
// So remote -> local writes are held back while a path is being edited, and only those: an upload only reads
// the file, so deferring uploads would break "Sync on file change" without protecting anything.
// The deferral covers the whole decision, not just the write: skipping only the write would leave the state
// DB claiming a body the file does not have.
import { DataAdapter } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { StateDB } from '../../../src/data/StateDB';
import { DEFAULT_SETTINGS, FileState, RemoteFileInfo, SyncSessionSummary } from '../../../src/types';

const PLUGIN_DIR = '.obsidian/plugins/obsidian-nextcloudsync';

function makeStateAdapter(): DataAdapter {
  const store: Record<string, string> = {};
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    readBinary: jest.fn(), writeBinary: jest.fn(),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(), rename: jest.fn(), stat: jest.fn(), list: jest.fn(),
  } as unknown as DataAdapter;
}

const summary = (): SyncSessionSummary => ({
  startedAt: 0, completedAt: null, uploadedCount: 0, downloadedCount: 0, deletedCount: 0,
  mergedCount: 0, conflictedCount: 0, errorCount: 0, retriedFiles: [], errors: [],
});

// An engine whose download and conflict paths are replaced by counters, so the test observes the DECISION
// rather than the machinery underneath it.
async function makeEngine(editing: Set<string>) {
  const stateDB = new StateDB(makeStateAdapter(), PLUGIN_DIR, 'dev-1');
  await stateDB.load();
  const base: FileState = {
    path: 'note.md', localHash: 'h-old', remoteId: 'e-old', idType: 'etag',
    size: 10, mtime: 1, remoteFileId: 'f', isConflicted: false,
  };
  stateDB.setFile(base);

  const engine = new SyncEngine({
    app: {}, settings: { ...DEFAULT_SETTINGS },
    localAdapter: {
      stat: async () => ({ size: 10, mtime: 1 }),
      readBinary: async () => new TextEncoder().encode('h-new').buffer,
    },
    stateDB, statusBar: {}, webdavFactory: {}, pluginDir: PLUGIN_DIR, configDir: '.obsidian',
    isBeingEdited: (p: string) => editing.has(p),
  } as never);

  const calls = { downloads: 0, conflicts: 0, uploads: 0 };
  const e = engine as unknown as Record<string, unknown>;
  e.downloadFile = async () => { calls.downloads++; };
  e.handleConflict = async () => { calls.conflicts++; };
  e.uploadFile = async () => { calls.uploads++; };
  e.isLocallyUnchanged = () => false; // the user typed: local differs from base

  return { engine, calls, base, stateDB };
}

const remote = (etag: string): RemoteFileInfo => ({
  path: 'note.md', fileId: 'f', checksum: null, etag, size: 10, lastModified: 0,
});

const classify = (engine: unknown, r: RemoteFileInfo) =>
  (engine as { processRemoteFile: (r: RemoteFileInfo, s: SyncSessionSummary) => Promise<void> })
    .processRemoteFile(r, summary());

describe('[SPEC:WOV-2] remote → local writes wait for the typing to stop', () => {
  it('defers a download while the file is being edited, and queues it', async () => {
    const { engine, calls } = await makeEngine(new Set(['note.md']));
    // Remote moved, local did not: normally a straight download over the open file.
    (engine as unknown as Record<string, unknown>).isLocallyUnchanged = () => true;

    await classify(engine, remote('e-new'));

    expect(calls.downloads).toBe(0);
    // Deferred, not dropped. The path comes back on the retry queue so the next sync decides again
    // with fresh state — a few seconds later, once the editor has gone quiet.
    expect((engine as unknown as { retryQueue: string[] }).retryQueue).toContain('note.md');
  });

  it('defers a conflict resolution while the file is being edited', async () => {
    const { engine, calls } = await makeEngine(new Set(['note.md']));

    await classify(engine, remote('e-new')); // both sides changed → conflict

    // This is the case that produced the marker blocks appearing mid-sentence.
    expect(calls.conflicts).toBe(0);
    expect((engine as unknown as { retryQueue: string[] }).retryQueue).toContain('note.md');
  });

  it('still uploads while the file is being edited', async () => {
    const { engine, calls } = await makeEngine(new Set(['note.md']));

    // Local changed, remote did not: an upload, which only READS the file.
    await classify(engine, remote('e-old'));

    // Deferring this would defeat the whole point of "Sync on file change" — the edit would sit
    // unsynced for as long as the user kept working.
    expect(calls.uploads).toBe(1);
    expect(calls.downloads).toBe(0);
    expect(calls.conflicts).toBe(0);
  });

  it('writes normally once the file is no longer being edited', async () => {
    const { engine, calls } = await makeEngine(new Set()); // nothing under the cursor
    (engine as unknown as Record<string, unknown>).isLocallyUnchanged = () => true;

    await classify(engine, remote('e-new'));

    expect(calls.downloads).toBe(1);
    expect((engine as unknown as { retryQueue: string[] }).retryQueue).not.toContain('note.md');
  });
});
