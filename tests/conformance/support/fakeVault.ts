// In-memory Obsidian App/Vault/DataAdapter for SyncEngine conformance tests.
// Backs LocalAdapter (adapter surface) and scanLocalFiles (vault.getFiles index).
import { App, DataAdapter, TFile, Vault } from 'obsidian';

interface Entry { data: ArrayBuffer; mtime: number; }

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (a: ArrayBuffer): string => new TextDecoder().decode(a);

export class FakeVault {
  private readonly store = new Map<string, Entry>();
  private readonly trashed = new Set<string>();
  readonly adapter: DataAdapter;
  readonly vault: Vault;
  readonly app: App;

  constructor() {
    const store = this.store;
    const trashed = this.trashed;

    this.adapter = {
      async read(p: string): Promise<string> {
        const e = store.get(p);
        if (!e) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        return dec(e.data);
      },
      async write(p: string, d: string): Promise<void> { store.set(p, { data: enc(d), mtime: Date.now() }); },
      async readBinary(p: string): Promise<ArrayBuffer> {
        const e = store.get(p);
        if (!e) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        return e.data;
      },
      async writeBinary(p: string, d: ArrayBuffer): Promise<void> { store.set(p, { data: d, mtime: Date.now() }); },
      async exists(p: string): Promise<boolean> { return store.has(p); },
      async remove(p: string): Promise<void> { store.delete(p); },
      async rename(from: string, to: string): Promise<void> {
        const e = store.get(from);
        if (e) { store.set(to, e); store.delete(from); }
      },
      async stat(p: string): Promise<{ size: number; mtime: number } | null> {
        const e = store.get(p);
        return e ? { size: e.data.byteLength, mtime: e.mtime } : null;
      },
      async list(): Promise<{ files: string[]; folders: string[] }> { return { files: [], folders: [] }; },
      async mkdir(): Promise<void> { /* flat store — no-op */ },
    } as unknown as DataAdapter;

    this.vault = {
      adapter: this.adapter,
      getFiles(): TFile[] {
        // Plain objects with the shape SyncEngine/LocalAdapter reads (path + stat),
        // cast to TFile — the real obsidian TFile type has no public constructor.
        return [...store.entries()]
          .filter(([p]) => !p.endsWith('.nextcloudsync.tmp'))
          .map(([p, e]) => ({ path: p, stat: { ctime: 0, mtime: e.mtime, size: e.data.byteLength } } as unknown as TFile));
      },
      getAbstractFileByPath(p: string): TFile | null { return store.has(p) ? ({ path: p } as unknown as TFile) : null; },
      async trash(file: TFile): Promise<void> { trashed.add(file.path); store.delete(file.path); },
    } as unknown as Vault;

    this.app = {
      vault: this.vault,
      fileManager: { async trashFile(file: TFile): Promise<void> { trashed.add(file.path); store.delete(file.path); } },
      saveLocalStorage(): void { /* no-op */ },
      loadLocalStorage(): string | null { return null; },
    } as unknown as App;
  }

  /** Seed a local file as if the user created it (visible to vault.getFiles). */
  seedLocal(path: string, content: string): void { this.store.set(path, { data: enc(content), mtime: Date.now() }); }
  readLocal(path: string): string | null { const e = this.store.get(path); return e ? dec(e.data) : null; }
  localExists(path: string): boolean { return this.store.has(path); }
  isTrashed(path: string): boolean { return this.trashed.has(path); }
}
