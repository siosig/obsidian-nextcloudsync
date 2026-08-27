// Pure predicates lifted out of SyncEngine (feature 074, Phase 1).
//
// These decide things — is this file unchanged, is this path ours to sync, does this extension merge
// as text — without touching the network, the disk, or engine state. They lived as private methods
// only because that is where they were written; nothing about them needs an engine instance.
//
// Exported as plain functions rather than a class. A class here would imply there is something to
// construct and inject, and there is not: every input arrives as an argument. That is deliberate, and
// it is what makes these directly testable — several of them previously had no test that named them,
// because reaching them meant standing up a SyncEngine first.
//
// Where a predicate used to read an ambient value (`Date.now()`, `this.opts.settings`, the state DB),
// that value is now a parameter. The caller resolves it. This is the whole reason the safety-window
// logic below can be exercised at its boundaries at all.
import { FileState } from '../../types';
import { SIGNATURE_SAFETY_WINDOW_MS } from '../../util/limits';
import { isUnderExcludedFolder, HARD_EXCLUDED_FOLDERS } from '../../util/excludedFolders';
import { isSyncTmpPath } from '../../data/LocalAdapter';
import { DIR_BREAKER_REPORT_FILENAME, FILE_BREAKER_REPORT_FILENAME } from '../../ui/breakerReport';

/** Parent-directory key of a vault-relative path ('' for a root-level file). */
export function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** True when a vault path's last segment is dot-prefixed. */
export function isDotName(path: string): boolean {
  const i = path.lastIndexOf('/');
  return (i < 0 ? path : path.slice(i + 1)).startsWith('.');
}

/**
 * True when `mtime` sits within the signature safety window of `ref`.
 *
 * The window exists because filesystem mtime granularity is coarse (1–2 s on some mobile storage): an
 * in-place edit that keeps the file's size and lands inside that granularity is indistinguishable from
 * no edit at all by stat alone. Treating such a file as "unchanged" would silently skip it.
 */
export function withinSafetyWindow(mtime: number, ref: number): boolean {
  return Math.abs(ref - mtime) < SIGNATURE_SAFETY_WINDOW_MS;
}

/**
 * True when the local file can be trusted as unchanged since our own last write, so the sync may skip
 * hashing it.
 *
 * Compares against the stat signature captured immediately after the plugin's own write
 * (`localMtime`/`localSize`). This works on mobile, where `setMtime` is a no-op so the on-disk mtime
 * never equals the remote mtime — the old `mtime <= base.mtime` filter therefore failed for every
 * previously-synced file and forced a full-vault rehash every sync.
 *
 * Returns false (⇒ must hash) when the signature is absent (migrated/old state), the size or mtime
 * differs, or the file's mtime falls inside the safety window around `now` or `lastSync`.
 *
 * `clock` supplies the two time inputs as accessors rather than values. That is deliberate and it is
 * not indirection for its own sake: the original read them only after the signature and size/mtime
 * checks had passed, and this predicate runs once per file on the fast path. Taking plain numbers
 * would force every caller to consult the state DB up front for the common case that returns on the
 * first line — a change in what the function does, not merely where it lives.
 *
 * @param clock.now - current time in ms
 * @param clock.lastSyncTime - completion time of the previous sync in ms, or 0 when there is none
 */
export function isLocallyUnchanged(
  base: FileState,
  stat: { mtime: number; size: number },
  clock: { now(): number; lastSyncTime(): number },
): boolean {
  if (base.localMtime == null || base.localSize == null) return false; // no signature → hash once
  if (stat.size !== base.localSize) return false;
  if (stat.mtime !== base.localMtime) return false;
  const now = clock.now();
  const lastSync = clock.lastSyncTime();
  if (withinSafetyWindow(stat.mtime, now)) return false;
  if (lastSync > 0 && withinSafetyWindow(stat.mtime, lastSync)) return false;
  return true;
}

/** True when `path`'s extension is an Auto Merge File type (used for Compare's text-diff eligibility). */
export function isTextEligible(path: string, autoMergeFileTypes: readonly string[]): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return autoMergeFileTypes.includes(ext);
}

/**
 * What {@link isSystemExcluded} needs to decide. Declared here rather than importing the engine's
 * options so the dependency runs one way only: policy knows nothing about SyncEngine.
 */
export interface SystemExclusionContext {
  /** The user's excluded-folder list (feature 027). */
  excludedFolders: readonly string[];
  /** Whether the path lives under the Obsidian config folder. */
  isUnderConfigDir(path: string): boolean;
  /** Whether an enabled config-sync category includes this config-folder path. */
  isConfigPathIncluded(path: string): boolean;
  /** Whether the path is this device's own log file while logging is on. */
  isActiveLogFile?(path: string): boolean;
}

/**
 * True when the plugin must not sync `path`, regardless of user settings.
 *
 * This is also the scope guard for remote deletions: a malicious or compromised server could fabricate
 * a deletion for `.obsidian/...`, and without this check that would reach a raw filesystem remove and
 * destroy config the sync engine otherwise never touches. Every server-driven sink consults it, which
 * is why it is worth being able to test the boundary directly rather than only through a full engine.
 */
export function isSystemExcluded(path: string, ctx: SystemExclusionContext): boolean {
  // The plugin's own atomic-write temp files are never sync content (defense in depth:
  // the vault watchers already filter them, but a leftover tmp must not be uploaded either).
  if (isSyncTmpPath(path)) return true;
  // Mass-delete breaker report notes (feature 056): fixed vault-root filenames, regenerated and
  // overwritten each time the user opens them. Device-local diagnostic snapshots, not vault
  // content — syncing them would just churn against the next overwrite.
  if (path === DIR_BREAKER_REPORT_FILENAME || path === FILE_BREAKER_REPORT_FILENAME) return true;
  // This device's own per-device log file, while its output toggle is ON: the plugin appends to
  // it during the sync, so syncing it would race the live append (Obsidian's rename throws
  // "Destination file already exists!") and churn. Turning the log OFF makes it static and
  // syncable again. Another device's log (different host) is not written here and stays syncable.
  if (ctx.isActiveLogFile?.(path)) return true;
  // Machine-managed vault-root folders (.git, .trash): permanent hard exclusion, independent of
  // the user's list. `.git` piecewise sync corrupts the repo (discussion #6); `.trash` is
  // Obsidian's device-local trash whose sync clutters every device and churns against the
  // plugin's own trashFile-based deletion. Targeted list — other root dot content still syncs.
  if (isUnderExcludedFolder(path, HARD_EXCLUDED_FOLDERS)) return true;
  // User-managed excluded folders (feature 027): folder-prefix match, applied to every
  // path before the config-folder logic so it covers ordinary vault files too. This is an
  // additive layer on top of the hard exclusions above — those always take precedence.
  if (isUnderExcludedFolder(path, ctx.excludedFolders)) return true;
  // Ordinary vault files (outside the config folder) are never system-excluded.
  if (!ctx.isUnderConfigDir(path)) return false;
  // Inside the config folder: excluded unless an enabled config-sync category includes it.
  // Community plugins (plugins/) and the plugin's own state DB are never included (hard
  // exclusions inside ConfigSyncResolver), so the remote-deletion scope guard — which also
  // calls this function — keeps protecting them.
  return !ctx.isConfigPathIncluded(path);
}
