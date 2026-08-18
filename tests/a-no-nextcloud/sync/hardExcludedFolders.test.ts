import { SyncEngine } from '../../../src/sync/SyncEngine';
import { DavSyncSettings } from '../../../src/types';
import { DIR_BREAKER_REPORT_FILENAME, FILE_BREAKER_REPORT_FILENAME } from '../../../src/ui/breakerReport';

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

// Feature 056: the mass-delete breaker report notes (fixed vault-root filenames, regenerated and
// overwritten on demand — see src/ui/breakerReport.ts) are device-local diagnostic snapshots, not
// vault content worth syncing. Same rationale as the per-device debug log exclusion
// (isActiveLogFile): syncing a snapshot that's about to be overwritten again just churns.
describe('[SPEC:MDV-5] breaker report notes are excluded from sync (feature 056)', () => {
  it('excludes both fixed report filenames at the vault root', () => {
    expect(isSystemExcluded(DIR_BREAKER_REPORT_FILENAME)).toBe(true);
    expect(isSystemExcluded(FILE_BREAKER_REPORT_FILENAME)).toBe(true);
  });

  it('does not exclude an ordinary vault file with a similar-looking name', () => {
    expect(isSystemExcluded('nextcloud-sync-dir-breaker-report-old.md')).toBe(false);
    expect(isSystemExcluded('notes/nextcloud-sync-dir-breaker-report.md')).toBe(false);
  });
});

// Feature: exclusion of hidden files and dotfolders (default ON; toggles allow opt-out).
function isSystemExcludedWith(path: string, overrides: Partial<DavSyncSettings>): boolean {
  const settings = {
    configDir: '.obsidian',
    logsFolder: '',
    loggingEnabled: false,
    syncConfigFolder: false,
    excludedFolders: [],
    excludeHiddenFiles: false,
    excludeDotFolders: false,
    configSync: { appearance: false, themesSnippets: false, hotkeys: false, corePlugins: false, bookmarks: false },
    ...overrides,
  } as unknown as DavSyncSettings;
  const engine = new SyncEngine({
    app: {}, settings, configDir: '.obsidian', pluginDir: '.obsidian/plugins/nextcloud-sync',
    localAdapter: {}, stateDB: {}, statusBar: {}, webdavFactory: {},
  } as never);
  return (engine as unknown as { isSystemExcluded(p: string): boolean }).isSystemExcluded(path);
}

describe('opt-in exclude hidden files', () => {
  it('excludes files whose basename starts with "." when enabled', () => {
    expect(isSystemExcludedWith('.env', { excludeHiddenFiles: true })).toBe(true);
    expect(isSystemExcludedWith('.gitignore', { excludeHiddenFiles: true })).toBe(true);
    expect(isSystemExcludedWith('secret/.env', { excludeHiddenFiles: true })).toBe(true);
  });

  it('does NOT exclude hidden files when the toggle is off (preserves prior behaviour)', () => {
    expect(isSystemExcludedWith('.env', {})).toBe(false);
    expect(isSystemExcludedWith('.gitignore', {})).toBe(false);
  });

  it('does NOT exclude ordinary files even when enabled', () => {
    expect(isSystemExcludedWith('note.md', { excludeHiddenFiles: true })).toBe(false);
    expect(isSystemExcludedWith('Attachments/clip.mp4', { excludeHiddenFiles: true })).toBe(false);
  });
});

describe('opt-in exclude dotfolders', () => {
  it('excludes dotfolders and their subtree when enabled', () => {
    expect(isSystemExcludedWith('.obsidian', { excludeDotFolders: true })).toBe(true);
    expect(isSystemExcludedWith('.obsidian/config.json', { excludeDotFolders: true })).toBe(true);
    expect(isSystemExcludedWith('.hidden/note.md', { excludeDotFolders: true })).toBe(true);
    expect(isSystemExcludedWith('Notes/.hidden/deep/doc.md', { excludeDotFolders: true })).toBe(true);
  });

  it('does NOT exclude dotfolders when the toggle is off — matches the targeted-hard-list contract', () => {
    expect(isSystemExcludedWith('.archive/note.md', {})).toBe(false);
    expect(isSystemExcludedWith('.env', {})).toBe(false);
  });

  it('does NOT exclude ordinary folders even when enabled', () => {
    expect(isSystemExcludedWith('Notes/note.md', { excludeDotFolders: true })).toBe(false);
    expect(isSystemExcludedWith('Attachments/Large media/clip.mp4', { excludeDotFolders: true })).toBe(false);
  });

  it('hard .git/.trash exclusion still applies even when the toggle is off', () => {
    expect(isSystemExcludedWith('.git/config', {})).toBe(true);
    expect(isSystemExcludedWith('.trash/x.md', {})).toBe(true);
  });
});

describe('DEFAULT_SETTINGS: dot-file/dot-folder exclusion is ON by default', () => {
  it('excludeHiddenFiles and excludeDotFolders default to true', () => {
    const { DEFAULT_SETTINGS } = require('../../../src/types');
    expect(DEFAULT_SETTINGS.excludeHiddenFiles).toBe(true);
    expect(DEFAULT_SETTINGS.excludeDotFolders).toBe(true);
  });

  it('a fresh-install engine excludes dot content without any explicit setting', () => {
    expect(isSystemExcludedWith('.env', { excludeHiddenFiles: true, excludeDotFolders: true })).toBe(true);
    expect(isSystemExcludedWith('Notes/.hidden/doc.md', { excludeHiddenFiles: true, excludeDotFolders: true })).toBe(true);
    expect(isSystemExcludedWith('note.md', { excludeHiddenFiles: true, excludeDotFolders: true })).toBe(false);
  });
});
