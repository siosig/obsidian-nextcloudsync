import { DataAdapter, FileView, Notice, Platform, TFile, Vault, Workspace, normalizePath } from 'obsidian';

export interface LocalFileEntry { path: string; size: number; mtime: number; }

// Atomic-write temp suffix, kept short: the temp file lives in the target's own directory and each path component is
// capped at NAME_MAX bytes (255 on ext4/F2FS), so the temp name must not inherit the target's length (see tmpPathFor).
// LEGACY_TMP_SUFFIX is only recognised, never produced, so stale temp files from older versions are still ignored and cleaned up.
const TMP_SUFFIX = '.ncs.tmp';
const LEGACY_TMP_SUFFIX = '.nextcloudsync.tmp';
const NAME_MAX_BYTES = 255;
const IGNORE_TIMEOUT_MS = 5000;

// NAME_MAX is measured in bytes, not UTF-16 code units.
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// Non-cryptographic 32-bit FNV-1a -> base36; it only needs to make per-target temp names unique within a directory.
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Short, fixed-length hidden temp name in the target's own directory: hash-derived so it stays within NAME_MAX even for
// near-limit targets, and same-directory so the final rename stays atomic.
export function tmpPathFor(targetPath: string): string {
  const lastSlash = targetPath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? targetPath.slice(0, lastSlash) : '';
  const tmpName = `.${shortHash(targetPath)}${TMP_SUFFIX}`;
  return dir ? `${dir}/${tmpName}` : tmpName;
}

// Rewrites a raw write error when the target's final name itself exceeds NAME_MAX (unstorable); other errors pass through
// unmasked. Only consulted from a catch block.
function translateNameTooLong(err: unknown, targetPath: string): unknown {
  const name = targetPath.slice(targetPath.lastIndexOf('/') + 1);
  const bytes = utf8ByteLength(name);
  if (bytes > NAME_MAX_BYTES) {
    return new Error(
      `File name too long (${bytes} bytes / max ${NAME_MAX_BYTES} bytes): "${name}". Shorten the file name.`,
    );
  }
  return err;
}

// This plugin's own atomic-write temp files (current and legacy suffix), never user content.
export function isSyncTmpPath(path: string): boolean {
  return path.endsWith(TMP_SUFFIX) || path.endsWith(LEGACY_TMP_SUFFIX);
}

// Uses the Adapter API rather than the Vault API: it gives tmp-write -> rename atomicity, reaches paths the Vault index
// does not track (state/log files), and reads raw bytes. Remote->local paths go through normalizePath() at the boundary.
export class LocalAdapter {
  private ignoreList: Map<string, number> = new Map();

  constructor(
    private readonly adapter: DataAdapter,
    private readonly vault?: Vault,
    private readonly workspace?: Workspace,
  ) {}

  // Resolves `path` to the TFile held by an open leaf, or null. A DEFERRED leaf (background tab, Obsidian >= 1.7.2) carries a
  // DeferredView that is not a FileView, so its path is read from the serialized view state and looked up via the Vault;
  // missing it sends the write down the destructive remove -> rename path that detaches the leaf (issues #15, #32).
  private findOpenTFile(path: string): TFile | null {
    if (!this.workspace) return null;
    let found: TFile | null = null;
    this.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view;
      if (view instanceof FileView && view.file?.path === path) {
        found = view.file;
        return;
      }
      if (!leaf.isDeferred || !this.vault) return;
      const statePath = leaf.getViewState()?.state?.file;
      if (typeof statePath === 'string' && statePath === path) {
        // getFileByPath returns null for a folder or a missing path, which correctly falls through
        // to the tmp-write path rather than pretending the file is open.
        found = this.vault.getFileByPath(path);
      }
    });
    return found;
  }

  ignore(path: string): void {
    const existing = this.ignoreList.get(path);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => this.ignoreList.delete(path), IGNORE_TIMEOUT_MS);
    // Node timers keep the process alive in tests: unref when present (window.setTimeout returns a number in Electron).
    (timer as unknown as { unref?: () => void }).unref?.();
    this.ignoreList.set(path, timer);
  }

  // Not consumed on read: one atomicWrite fires several Vault events (create/delete/rename) for the same path, so consuming
  // on the first would leak the rest as user edits. Entries expire by timeout.
  shouldIgnore(path: string): boolean {
    return this.ignoreList.has(path);
  }

  // Call from onunload so pending timers cannot fire after teardown or leak across reloads.
  dispose(): void {
    for (const timer of this.ignoreList.values()) window.clearTimeout(timer);
    this.ignoreList.clear();
  }

  private async ensureParentDir(filePath: string): Promise<void> {
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash > 0) {
      const dir = filePath.slice(0, lastSlash);
      // Mark the parent folder as our own write BEFORE creating it, so watch mode does not propagate the folder-create
      // back to the server as a spurious MKCOL.
      this.ignore(dir);
      await this.adapter.mkdir(dir);
    }
  }

  // An open leaf is updated in place via Vault.modify (no delete event, so Obsidian never detaches it, issue #15);
  // otherwise tmp-write -> remove existing -> rename.
  async atomicWrite(targetPath: string, content: string): Promise<void> {
    targetPath = normalizePath(targetPath);
    const openFile = this.findOpenTFile(targetPath);
    if (openFile) {
      this.ignore(targetPath);
      await this.vault!.modify(openFile, content);
      return;
    }
    const tmpPath = tmpPathFor(targetPath);
    this.ignore(tmpPath);
    this.ignore(targetPath);
    let targetRemoved = false;
    try {
      await this.ensureParentDir(targetPath);
      await this.adapter.write(tmpPath, content);
      if (await this.adapter.exists(targetPath)) {
        await this.adapter.remove(targetPath);
        targetRemoved = true;
      }
      await this.adapter.rename(tmpPath, targetPath);
    } catch (err) {
      // If remove(targetPath) already succeeded before rename threw, tmpPath is the ONLY surviving copy of the new content:
      // clean up tmp only when the destructive remove() never happened.
      if (!targetRemoved && await this.adapter.exists(tmpPath)) {
        await this.adapter.remove(tmpPath);
      }
      throw translateNameTooLong(err, targetPath);
    }
  }

  // Same open-file in-place path as atomicWrite (Vault.modifyBinary); otherwise tmp-write -> remove -> rename with read-back verification.
  async atomicWriteBinary(targetPath: string, data: ArrayBuffer): Promise<void> {
    targetPath = normalizePath(targetPath);
    const openFile = this.findOpenTFile(targetPath);
    if (openFile) {
      this.ignore(targetPath);
      await this.vault!.modifyBinary(openFile, data);
      return;
    }
    const tmpPath = tmpPathFor(targetPath);
    this.ignore(tmpPath);
    this.ignore(targetPath);
    let targetRemoved = false;
    try {
      await this.ensureParentDir(targetPath);
      await this.adapter.writeBinary(tmpPath, data);
      if (await this.adapter.exists(targetPath)) {
        await this.adapter.remove(targetPath);
        targetRemoved = true;
      }
      await this.adapter.rename(tmpPath, targetPath);
      // Read-back verification (docs/spec.md §9.2): fsync is unavailable through the adapter, so confirm the byte length;
      // a truncated write throws so the caller leaves Base unadvanced and re-syncs.
      const written = await this.adapter.stat(targetPath);
      if (!written || written.size !== data.byteLength) {
        throw new Error(`write-back verification failed for ${targetPath}: expected ${data.byteLength} bytes, found ${written ? written.size : 'none'}`);
      }
    } catch (err) {
      // See atomicWrite(): once remove(targetPath) has run, tmpPath may be the only copy and must not be deleted;
      // if rename already succeeded, tmp is gone and this is a no-op.
      if (!targetRemoved && await this.adapter.exists(tmpPath)) {
        await this.adapter.remove(tmpPath);
      }
      throw translateNameTooLong(err, targetPath);
    }
  }

  async read(path: string): Promise<string> {
    return this.adapter.read(normalizePath(path));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(normalizePath(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(path));
  }

  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    return this.adapter.stat(normalizePath(path));
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return this.adapter.list(normalizePath(path));
  }

  async setMtime(path: string, mtime: number): Promise<void> {
    // Node's fs is desktop-only; on mobile this is a no-op because change detection is hash-based.
    if (!Platform.isDesktopApp) return;
    try {
      const nodefs = (window as Window & { require?: (m: string) => { utimes: (p: string, a: number, m: number, cb: (e: Error | null) => void) => void } }).require?.('fs');
      const getFullPath = (this.adapter as unknown as { getFullPath?: (p: string) => string }).getFullPath?.bind(this.adapter);
      if (!nodefs || !getFullPath) return;
      const fullPath = getFullPath(normalizePath(path));
      const sec = mtime / 1000;
      await new Promise<void>((resolve, reject) =>
        nodefs.utimes(fullPath, sec, sec, (err) => (err ? reject(err) : resolve())),
      );
    } catch { /* best-effort: silently ignore on mobile or unsupported environments */ }
  }

  // Tmp files only: never call remove on user files.
  async removeTmp(tmpPath: string): Promise<void> {
    if (isSyncTmpPath(tmpPath) && await this.adapter.exists(tmpPath)) {
      await this.adapter.remove(tmpPath);
    }
  }

  showNotice(message: string, timeout = 4000): void {
    new Notice(message, timeout);
  }

  // Reads Vault.getFiles()/TFile.stat from Obsidian's in-memory index to avoid native-bridge round trips on mobile.
  // The config folder is not Vault-tracked and is excluded (callers inject it). Returns [] when no Vault was injected (unit tests).
  listVaultFiles(): LocalFileEntry[] {
    if (!this.vault) return [];
    return this.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
  }
}
