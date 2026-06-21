import { DataAdapter } from 'obsidian';
import { LocalAdapter } from '../../src/data/LocalAdapter';
import { SyncEngine } from '../../src/sync/SyncEngine';
import { DavSyncSettings } from '../../src/types';
import { isActiveOwnLog, debugLogPath, syncLogPath } from '../../src/util/logPaths';

/**
 * REPRODUCTION + FIX GUARD: the "Destination file already exists!" error reported on the
 * plugin's own per-device debug log (e.g. _logs/nextcloud-sync_debug_<host>.txt).
 *
 * Root cause established by investigation + live evidence:
 *  - The real Nextcloud server returns a DIFFERENT message for a MOVE/Overwrite:F to an existing
 *    destination ("The destination node already exists, and the overwrite header is set to false",
 *    HTTP 412, Sabre\DAV\Exception\PreconditionFailed) — verified against the live server.
 *  - The plugin's NetworkError.message is always "HTTP <status>", never the body, so a server 412
 *    could never surface as the reported text.
 *  - "Destination file already exists!" is the message Obsidian's DataAdapter.rename throws when the
 *    destination already exists. It is produced LOCALLY inside LocalAdapter.atomicWrite*.
 *  - The plugin's own log files are NOT excluded from sync (isSystemExcluded only filters the config
 *    folder + tmp files), so the log enters the sync's local-write path while FileLogger is still
 *    appending to it. Between atomicWrite's `remove(target)` and `rename(tmp,target)`, the concurrent
 *    append re-creates `target`, so the rename hits an existing destination → throws.
 *
 * These two tests reproduce both halves of the root cause against the real plugin code.
 */

const enc = new TextEncoder();
const toBuf = (s: string): ArrayBuffer => enc.encode(s).buffer;
const HOST = 'desktop-daidows';
const LOG_PATH = '_logs/nextcloud-sync_debug_desktop-daidows.txt';
const DEBUG_LOG = debugLogPath('_logs', HOST);
const SYNC_LOG = syncLogPath('_logs', HOST);

/**
 * An in-memory DataAdapter that mimics the two Obsidian behaviours that matter here:
 *  1. `rename(from,to)` THROWS `"Destination file already exists!"` when `to` already exists.
 *  2. a hook lets us simulate a concurrent writer (FileLogger) re-creating the target file in the
 *     window between atomicWrite's remove() and rename().
 */
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

describe('REPRO: plugin syncs its own debug log → local atomicWrite rename self-collision', () => {
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
  function excludedWith(opts: { debugLogEnabled: boolean; syncLogEnabled: boolean }, path: string): boolean {
    const settings = {
      configDir: '.obsidian', logsFolder: '_logs',
      debugLogEnabled: opts.debugLogEnabled, syncLogEnabled: opts.syncLogEnabled,
      syncConfigFolder: false,
      configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
    } as unknown as DavSyncSettings;
    const engine = new SyncEngine({
      app: {}, settings, configDir: '.obsidian', pluginDir: '.obsidian/plugins/nextcloud-sync',
      localAdapter: {}, stateDB: {}, statusBar: {}, webdavFactory: {},
      isActiveLogFile: (p: string) => isActiveOwnLog(p, {
        logsFolder: '_logs', host: HOST,
        debugLogEnabled: opts.debugLogEnabled, syncLogEnabled: opts.syncLogEnabled,
      }),
    } as never);
    return (engine as unknown as { isSystemExcluded(p: string): boolean }).isSystemExcluded(path);
  }

  it('excludes this device\'s debug log while Debug log is ON, and syncs it when OFF', () => {
    expect(excludedWith({ debugLogEnabled: true, syncLogEnabled: false }, DEBUG_LOG)).toBe(true);   // ON → excluded
    expect(excludedWith({ debugLogEnabled: false, syncLogEnabled: false }, DEBUG_LOG)).toBe(false); // OFF → syncable
  });

  it('excludes this device\'s sync log while Sync log is ON, and syncs it when OFF', () => {
    expect(excludedWith({ debugLogEnabled: false, syncLogEnabled: true }, SYNC_LOG)).toBe(true);   // ON → excluded
    expect(excludedWith({ debugLogEnabled: false, syncLogEnabled: false }, SYNC_LOG)).toBe(false); // OFF → syncable
  });

  it('never excludes an ordinary note', () => {
    expect(excludedWith({ debugLogEnabled: true, syncLogEnabled: true }, 'Notes/a.md')).toBe(false);
  });
});
