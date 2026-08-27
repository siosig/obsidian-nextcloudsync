// Local enumeration lifted out of SyncEngine (feature 074, Phase 2).
//
// Answers one question — which local paths are in sync scope, and what are their stats — and answers
// it without deciding anything about them. No hashing happens here: hashing is deferred to
// buildInitialPlan, which only hashes what a size comparison could not already classify. That is why
// this can be a leaf at all.
//
// The dependencies below are declared here rather than imported from SyncEngineOptions, so the
// direction of knowledge runs one way: the scanner does not know what a SyncEngine is.
import { LocalAdapter } from '../../data/LocalAdapter';
import { isDotName } from '../policy';

/** Path → stat map, the scanner's only output shape. */
export type LocalStats = Map<string, { size: number; mtime: number }>;

/**
 * What the scanner needs. Deliberately smaller than the engine's options: the two exclusion
 * predicates arrive as functions rather than as settings, because the scanner has no business
 * knowing how exclusion is decided — only whether a given path is excluded.
 */
export interface LocalScanDeps {
  localAdapter: Pick<LocalAdapter, 'listVaultFiles' | 'list' | 'stat'>;
  /** The system-exclusion rules (src/sync/policy), already bound to the caller's settings. */
  isSystemExcluded(path: string): boolean;
  /** Whether the path lives under the Obsidian config folder, which is enumerated separately. */
  isUnderConfigDir(path: string): boolean;
  /** Config-folder paths the enabled config-sync categories include. */
  enumerateIncludedConfigPaths(): Promise<string[]>;
}

export class LocalScanner {
  constructor(private readonly deps: LocalScanDeps) {}

  /**
   * Full local scan: Vault-tracked files, the enabled config-sync paths, and the dot paths the Vault
   * index omits.
   */
  async scanLocalFiles(): Promise<LocalStats> {
    const results: LocalStats = new Map();
    // Enumerate Vault-tracked files from the in-memory index (no native FS round-trips on mobile).
    // Task 3 (P1): hashing is deferred entirely to buildInitialPlan, which only hashes files that
    // need a checksum comparison to be classified as unchanged (remote exists + sizes match + server
    // checksum present). This eliminates all readBinary calls during the initial scan on mobile.
    for (const e of this.deps.localAdapter.listVaultFiles()) {
      if (this.deps.isSystemExcluded(e.path)) continue;
      results.set(e.path, { size: e.size, mtime: e.mtime });
    }
    // The config folder is not Vault-tracked; inject the enabled config-sync category paths explicitly.
    for (const p of await this.deps.enumerateIncludedConfigPaths()) {
      const stat = await this.deps.localAdapter.stat(p);
      if (stat) results.set(p, { size: stat.size, mtime: stat.mtime });
    }
    // Task 7 (C1 fix): Vault.getFiles() omits ALL dot-prefixed paths, but the previous
    // adapter.list() scan synced non-.obsidian dot files/folders. Re-enumerate them here.
    await this.collectDotPaths(results);
    return results;
  }

  /**
   * Collect path→stat for local files in sync scope without computing hashes (Vault-cache based).
   * Unlike {@link scanLocalFiles} this does NOT inject config paths — the caller does that itself.
   */
  async collectLocalStats(out: LocalStats): Promise<void> {
    for (const e of this.deps.localAdapter.listVaultFiles()) {
      if (this.deps.isSystemExcluded(e.path)) continue;
      out.set(e.path, { size: e.size, mtime: e.mtime });
    }
    // The config folder is not Vault-tracked; the caller injects enabled config-sync paths separately.
    // Task 7 (C1 fix): supplement with non-config dot paths that Vault.getFiles() omits.
    await this.collectDotPaths(out);
  }

  /**
   * Re-enumerate non-config dot paths that Vault.getFiles() omits. Vault excludes ALL dot-prefixed
   * paths, but the previous adapter.list scan synced non-.obsidian dotfiles/folders (e.g. .archive/),
   * so the Vault switch would silently stop syncing them. The config folder is handled separately by
   * ConfigSyncResolver and is skipped here. NOTE: dot files nested inside NON-dot folders
   * (e.g. notes/.foo.md) are intentionally out of scope — Obsidian does not index them and a full
   * recursion would defeat the Vault-cache round-trip savings.
   *
   * Private on purpose: the two enumeration routes are not interchangeable, and collapsing the walk
   * onto the Vault index alone would silently stop syncing every dot path.
   */
  private async collectDotPaths(out: LocalStats): Promise<void> {
    let root: { files: string[]; folders: string[] };
    try { root = await this.deps.localAdapter.list(''); } catch { return; }
    for (const file of root.files) {
      if (!isDotName(file)) continue;
      if (this.deps.isSystemExcluded(file)) continue;
      const st = await this.deps.localAdapter.stat(file);
      if (st) out.set(file, { size: st.size, mtime: st.mtime });
    }
    for (const folder of root.folders) {
      if (!isDotName(folder)) continue;
      if (this.deps.isUnderConfigDir(folder)) continue; // .obsidian handled by ConfigSyncResolver
      if (this.deps.isSystemExcluded(folder)) continue; // .git/.trash: skip the whole tree (no recursion into a huge .git)
      await this.collectStatsRecursiveViaAdapter(folder, out);
    }
  }

  /** Recursively enumerate a (Vault-untracked) directory's files via the adapter, stats only. */
  private async collectStatsRecursiveViaAdapter(dir: string, out: LocalStats): Promise<void> {
    let listing: { files: string[]; folders: string[] };
    try { listing = await this.deps.localAdapter.list(dir); } catch { return; }
    for (const file of listing.files) {
      if (this.deps.isSystemExcluded(file)) continue;
      const st = await this.deps.localAdapter.stat(file);
      if (st) out.set(file, { size: st.size, mtime: st.mtime });
    }
    for (const folder of listing.folders) {
      await this.collectStatsRecursiveViaAdapter(folder, out);
    }
  }
}
