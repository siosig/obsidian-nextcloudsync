import { DataAdapter } from 'obsidian';
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DavSyncSettings } from '../../../src/types';
import { isActiveOwnLog, debugLogPath } from '../../../src/util/logPaths';

// Regression guard for "Destination file already exists!" on the plugin's own per-device debug log
// (_logs/nextcloud-debug_<host>.txt). Obsidian's DataAdapter.rename throws that message locally when the destination
// exists: while FileLogger appends to the log, a concurrent append re-creates `target` between atomicWrite's
// remove(target) and rename(tmp,target). (docs/spec.md §9.1)

const enc = new TextEncoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer;
const HOST = 'desktop-daidows';
const LOG_PATH = '_logs/nextcloud-debug_desktop-daidows.txt';
const DEBUG_LOG = debugLogPath('_logs', HOST);

// An in-memory DataAdapter: rename(from,to) THROWS "Destination file already exists!" when `to` exists, and a hook
// simulates a concurrent writer (FileLogger) re-creating the target between atomicWrite's remove() and rename().
function makeObsidianLikeAdapter(target: string, onRemoveTarget: () => void) {
  const files = new Map<string, ArrayBuffer>();
  const adapter = {
    mkdir: jest.fn(async () => undefined),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files.set(p, d); }),
    exists: jest.fn(async (p: string) => files.has(p)),
    remove: jest.fn(async (p: string) => {
      files.delete(p);
      // Only the real target's removal opens the race window; the tmp cleanup in the catch must not.
      if (p === target) onRemoveTarget();
    }),
    rename: jest.fn(async (from: string, to: string) => {
      if (files.has(to)) throw new Error('Destination file already exists!'); // Obsidian's exact message
      files.set(to, files.get(from) as ArrayBuffer);
      files.delete(from);
    }),
  } as unknown as DataAdapter;
  return { adapter, files };
}

describe('[SPEC:LOG-1] REPRO: plugin syncs its own debug log → local atomicWrite rename self-collision', () => {
  it('atomicWriteBinary on the live log throws Obsidian\'s "Destination file already exists!"', async () => {
    // The live debug log already exists (FileLogger has been appending to it).
    let filesRef: Map<string, ArrayBuffer>;
    const reAppend = () => filesRef.set(LOG_PATH, toBuf('old log + a line FileLogger appended mid-sync'));
    const { adapter, files } = makeObsidianLikeAdapter(LOG_PATH, reAppend);
    filesRef = files;
    files.set(LOG_PATH, toBuf('old log')); // exists before the sync writes it

    const local = new LocalAdapter(adapter);

    // The sync resolves the log as remote-wins / merge and writes it locally. atomicWrite does
    // writeTmp → remove(target) → rename(tmp,target); FileLogger re-creates target inside that window.
    await expect(local.atomicWriteBinary(LOG_PATH, toBuf('content the sync wants to write')))
      .rejects.toThrow('Destination file already exists!');
  });

  // FIX (regression guard): the live log is kept out of sync while its toggle is ON, so the local
  // write above never happens for it; turning the toggle OFF makes the now-static file syncable.
  function excludedWith(loggingEnabled: boolean, path: string): boolean {
    const settings = {
      configDir: '.obsidian', logsFolder: '_logs',
      loggingEnabled,
      syncConfigFolder: false,
      configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
    } as unknown as DavSyncSettings;
    const engine = new SyncEngine({
      app: {}, settings, configDir: '.obsidian', pluginDir: '.obsidian/plugins/nextcloud-sync',
      localAdapter: {}, stateDB: {}, statusBar: {}, webdavFactory: {},
      isActiveLogFile: (p: string) => isActiveOwnLog(p, {
        logsFolder: '_logs', host: HOST,
        loggingEnabled,
      }),
    } as never);
    return (engine as unknown as { isSystemExcluded(p: string): boolean }).isSystemExcluded(path);
  }

  it('excludes this device\'s log while logging is ON, and syncs it when OFF', () => {
    expect(excludedWith(true, DEBUG_LOG)).toBe(true);   // ON → excluded
    expect(excludedWith(false, DEBUG_LOG)).toBe(false); // OFF → syncable
  });

  it('never excludes an ordinary note', () => {
    expect(excludedWith(true, 'Notes/a.md')).toBe(false);
  });
});
