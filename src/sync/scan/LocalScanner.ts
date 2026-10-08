// Answers which local paths are in sync scope and what their stats are, without deciding anything about them.
// No hashing happens here (buildInitialPlan hashes only what a size comparison could not classify). The deps
// are declared here, not imported from SyncEngineOptions, so the scanner does not know what a SyncEngine is.
import { LocalAdapter } from '../../data/LocalAdapter';
import { isDotName } from '../policy';

export type LocalStats = Map<string, { size: number; mtime: number }>;

// Exclusion arrives as predicates, not settings: the scanner only needs to know whether a path is excluded.
export interface LocalScanDeps {
  localAdapter: Pick<LocalAdapter, 'listVaultFiles' | 'list' | 'stat'>;
  isSystemExcluded(path: string): boolean;
  isUnderConfigDir(path: string): boolean;
  enumerateIncludedConfigPaths(): Promise<string[]>;
}

export class LocalScanner {
  constructor(private readonly deps: LocalScanDeps) {}


  async scanLocalFiles(): Promise<LocalStats> {
    const results: LocalStats = new Map();
    // The in-memory Vault index avoids native FS round-trips on mobile; hashing is deferred to buildInitialPlan.
    for (const e of this.deps.localAdapter.listVaultFiles()) {
      if (this.deps.isSystemExcluded(e.path)) continue;
      results.set(e.path, { size: e.size, mtime: e.mtime });
    }
    // The config folder is not Vault-tracked; inject the enabled config-sync category paths explicitly.
    for (const p of await this.deps.enumerateIncludedConfigPaths()) {
      const stat = await this.deps.localAdapter.stat(p);
      if (stat) results.set(p, { size: stat.size, mtime: stat.mtime });
    }
    // Vault.getFiles() omits ALL dot-prefixed paths, so re-enumerate the non-.obsidian ones here.
    await this.collectDotPaths(results);
    return results;
  }

  // Unlike scanLocalFiles this does NOT inject config paths; the caller does that itself.
  async collectLocalStats(out: LocalStats): Promise<void> {
    for (const e of this.deps.localAdapter.listVaultFiles()) {
      if (this.deps.isSystemExcluded(e.path)) continue;
      out.set(e.path, { size: e.size, mtime: e.mtime });
    }
    // Supplement with the non-config dot paths that Vault.getFiles() omits.
    await this.collectDotPaths(out);
  }

  // Vault excludes ALL dot-prefixed paths, so non-.obsidian dotfiles/folders (e.g. .archive/) are re-enumerated
  // here; the config folder is handled by ConfigSyncResolver. Dot files nested in NON-dot folders (notes/.foo.md)
  // are out of scope: Obsidian does not index them and a full recursion would defeat the Vault-cache savings.
  // Private on purpose: walking the Vault index alone would silently stop syncing every dot path.
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
      if (this.deps.isUnderConfigDir(folder)) continue;
      if (this.deps.isSystemExcluded(folder)) continue; // skip the whole tree, e.g. a huge .git
      await this.collectStatsRecursiveViaAdapter(folder, out);
    }
  }

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
