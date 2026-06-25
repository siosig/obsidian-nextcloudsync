// In-memory Obsidian App/Vault/DataAdapter for SyncEngine conformance tests.
// Backs LocalAdapter (adapter surface) and scanLocalFiles (vault.getFiles index).
// Models directories (folders) so empty-directory pruning (DP) can be driven end to end:
// folders exist implicitly as ancestors of files and explicitly via mkdir/seedFolder, and
// trashing a folder removes its whole subtree.
import { App, DataAdapter, TFile, TFolder, Vault } from 'obsidian';

interface Entry { data: ArrayBuffer; mtime: number; }

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (a: ArrayBuffer): string => new TextDecoder().decode(a);

// The real obsidian TFolder has no public constructor, but the b1 jest mock provides one;
// `instanceof TFolder` in SyncEngine.pruneEmptyLocalDirs requires a genuine mock instance, so
// construct via the runtime class while satisfying the compile-time (real) types with a cast.
const TFolderCtor = TFolder as unknown as { new (path: string): TFolder };
const mkFolder = (path: string): TFolder => new TFolderCtor(path);

/** Every ancestor directory path of a vault-relative file/folder path (excluding '' root). */
function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let i = path.indexOf('/');
  while (i >= 0) { out.push(path.slice(0, i)); i = path.indexOf('/', i + 1); }
  return out;
}

export class FakeVault {
  private readonly store = new Map<string, Entry>();
  private readonly explicitFolders = new Set<string>();
  private readonly trashed = new Set<string>();
  readonly adapter: DataAdapter;
  readonly vault: Vault;
  readonly app: App;

  constructor() {
    const store = this.store;
    const explicitFolders = this.explicitFolders;
    const trashed = this.trashed;
    const self = this;

    const addAncestors = (p: string): void => { for (const a of ancestorsOf(p)) explicitFolders.add(a); };

    this.adapter = {
      async read(p: string): Promise<string> {
        const e = store.get(p);
        if (!e) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        return dec(e.data);
      },
      async write(p: string, d: string): Promise<void> { addAncestors(p); store.set(p, { data: enc(d), mtime: Date.now() }); },
      async readBinary(p: string): Promise<ArrayBuffer> {
        const e = store.get(p);
        if (!e) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        return e.data;
      },
      async writeBinary(p: string, d: ArrayBuffer): Promise<void> { addAncestors(p); store.set(p, { data: d, mtime: Date.now() }); },
      async exists(p: string): Promise<boolean> { return store.has(p) || self.folderExists(p); },
      async remove(p: string): Promise<void> { store.delete(p); explicitFolders.delete(p); },
      async rename(from: string, to: string): Promise<void> {
        const e = store.get(from);
        if (e) { addAncestors(to); store.set(to, e); store.delete(from); }
      },
      async stat(p: string): Promise<{ size: number; mtime: number } | null> {
        const e = store.get(p);
        return e ? { size: e.data.byteLength, mtime: e.mtime } : null;
      },
      // Full vault-relative paths of the immediate children of `path` (mirrors Obsidian's adapter.list).
      async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        const prefix = path ? `${path}/` : '';
        const files = new Set<string>();
        const folders = new Set<string>();
        const immediate = (full: string): string | null => {
          if (!full.startsWith(prefix)) return null;
          const rest = full.slice(prefix.length);
          if (rest === '') return null;
          const slash = rest.indexOf('/');
          return slash >= 0 ? prefix + rest.slice(0, slash) : full;
        };
        for (const f of store.keys()) {
          const child = immediate(f);
          if (child === null) continue;
          if (child === f) files.add(child); else folders.add(child);
        }
        for (const d of self.allFolderPaths()) {
          const child = immediate(d);
          if (child !== null) folders.add(child);
        }
        return { files: [...files], folders: [...folders] };
      },
      async mkdir(p: string): Promise<void> { explicitFolders.add(p); addAncestors(p); },
    } as unknown as DataAdapter;

    this.vault = {
      adapter: this.adapter,
      getFiles(): TFile[] {
        return [...store.entries()]
          .filter(([p]) => !p.endsWith('.ncs.tmp') && !p.endsWith('.nextcloudsync.tmp'))
          .map(([p, e]) => ({ path: p, stat: { ctime: 0, mtime: e.mtime, size: e.data.byteLength } } as unknown as TFile));
      },
      getAllFolders(): TFolder[] {
        return [...self.allFolderPaths()].map((p) => mkFolder(p));
      },
      getAbstractFileByPath(p: string): TFile | TFolder | null {
        if (store.has(p)) return { path: p } as unknown as TFile;
        if (self.folderExists(p)) return mkFolder(p);
        return null;
      },
      async trash(file: TFile): Promise<void> { trashed.add(file.path); store.delete(file.path); },
    } as unknown as Vault;

    this.app = {
      vault: this.vault,
      fileManager: {
        async trashFile(file: TFile | TFolder): Promise<void> {
          const p = file.path;
          if (store.has(p)) { trashed.add(p); store.delete(p); return; }
          // Folder: trash the entire subtree (files + nested folders).
          const prefix = `${p}/`;
          for (const f of [...store.keys()]) if (f === p || f.startsWith(prefix)) { trashed.add(f); store.delete(f); }
          for (const d of [...explicitFolders]) if (d === p || d.startsWith(prefix)) explicitFolders.delete(d);
          explicitFolders.delete(p);
          trashed.add(p);
        },
      },
      saveLocalStorage(): void { /* no-op */ },
      loadLocalStorage(): string | null { return null; },
    } as unknown as App;
  }

  /** All folder paths: explicit (mkdir/seedFolder) ∪ every ancestor of every file. */
  private allFolderPaths(): Set<string> {
    const set = new Set<string>(this.explicitFolders);
    for (const f of this.store.keys()) for (const a of ancestorsOf(f)) set.add(a);
    set.delete('');
    return set;
  }

  folderExists(path: string): boolean { return this.allFolderPaths().has(path); }

  /** Seed a local file as if the user created it (visible to vault.getFiles); ancestors auto-created. */
  seedLocal(path: string, content: string): void {
    for (const a of ancestorsOf(path)) this.explicitFolders.add(a);
    this.store.set(path, { data: enc(content), mtime: Date.now() });
  }
  /** Seed an explicit (possibly empty) folder. */
  seedFolder(path: string): void { this.explicitFolders.add(path); for (const a of ancestorsOf(path)) this.explicitFolders.add(a); }
  readLocal(path: string): string | null { const e = this.store.get(path); return e ? dec(e.data) : null; }
  localExists(path: string): boolean { return this.store.has(path); }
  isTrashed(path: string): boolean { return this.trashed.has(path); }
  /** Simulate the user deleting a folder in the file explorer (removes its subtree + the folder). */
  deleteLocalTree(path: string): void {
    const prefix = `${path}/`;
    for (const f of [...this.store.keys()]) if (f === path || f.startsWith(prefix)) this.store.delete(f);
    for (const d of [...this.explicitFolders]) if (d === path || d.startsWith(prefix)) this.explicitFolders.delete(d);
  }
}
