import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DavSyncSettings } from '../../../src/types';

/**
 * [SPEC:EXCL-HARD-1] Machine-managed vault-root folders (.git, .trash) are PERMANENTLY excluded
 * from sync, regardless of the user's excludedFolders list.
 *
 * Motivation:
 *  - `.trash` is Obsidian's device-local trash (deletions land here when "Deleted files" =
 *    "Move to Obsidian trash"). Syncing it clutters every device's trash and churns against the
 *    plugin's own trashFile-based deletion (remote delete → local .trash move → re-upload).
 *  - `.git` is a machine-managed repository whose piecewise file sync corrupts the repo
 *    (discussion #6). The settings UI already DOCUMENTS these dotfolders as excluded; this makes
 *    the implementation match that promised contract.
 *
 * Scope guard: the exclusion is a TARGETED list, not a blanket "all dotfolders" rule. Non-machine
 * dotfolders/files at the vault root (e.g. .archive/, .env) must still sync (Task 7 / dotPaths).
 */

function isSystemExcluded(path: string): boolean {
  const settings = {
    configDir: '.obsidian',
    logsFolder: '',
    loggingEnabled: false,
    syncConfigFolder: false,
    excludedFolders: [],
    configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
  } as unknown as DavSyncSettings;
  const engine = new SyncEngine({
    app: {}, settings, configDir: '.obsidian', pluginDir: '.obsidian/plugins/nextcloud-sync',
    localAdapter: {}, stateDB: {}, statusBar: {}, webdavFactory: {},
  } as never);
  return (engine as unknown as { isSystemExcluded(p: string): boolean }).isSystemExcluded(path);
}

describe('[SPEC:EXCL-HARD-1] hard-excluded machine folders (.git / .trash)', () => {
  it('excludes the .trash folder and everything under it', () => {
    expect(isSystemExcluded('.trash')).toBe(true);
    expect(isSystemExcluded('.trash/note.md')).toBe(true);
    expect(isSystemExcluded('.trash/sub/deep.md')).toBe(true);
  });

  it('excludes the .git folder and everything under it', () => {
    expect(isSystemExcluded('.git')).toBe(true);
    expect(isSystemExcluded('.git/config')).toBe(true);
    expect(isSystemExcluded('.git/objects/ab/cdef')).toBe(true);
  });

  it('preserves sync of non-machine root dot content (Task 7: .archive/, .env)', () => {
    expect(isSystemExcluded('.archive/note.md')).toBe(false);
    expect(isSystemExcluded('.env')).toBe(false);
  });

  it('matches at a folder boundary — siblings and same-prefix files are NOT excluded', () => {
    // `.trashcan/` and `.github/` merely share a prefix; they are distinct folders → syncable.
    expect(isSystemExcluded('.trashcan/x.md')).toBe(false);
    expect(isSystemExcluded('.github/workflows/ci.yml')).toBe(false);
    // `.gitignore` is a user file, not the `.git` folder → syncable.
    expect(isSystemExcluded('.gitignore')).toBe(false);
  });

  it('does not touch ordinary vault files', () => {
    expect(isSystemExcluded('note.md')).toBe(false);
    expect(isSystemExcluded('folder/sub/doc.md')).toBe(false);
  });
});
