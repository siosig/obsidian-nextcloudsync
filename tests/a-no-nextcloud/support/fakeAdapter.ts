// In-memory DataAdapter for StateDB / SyncHistoryStore tests; implements only the surface those modules use.
import { DataAdapter } from 'obsidian';

export interface FakeAdapter extends DataAdapter {
  _files: Map<string, string>;
}

export function makeFakeAdapter(): FakeAdapter {
  const files = new Map<string, string>();
  return {
    _files: files,
    async read(p: string): Promise<string> {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async write(p: string, d: string): Promise<void> { files.set(p, d); },
    async exists(p: string): Promise<boolean> { return files.has(p); },
    async remove(p: string): Promise<void> { files.delete(p); },
    async rename(from: string, to: string): Promise<void> {
      const v = files.get(from);
      if (v !== undefined) { files.set(to, v); files.delete(from); }
    },
    async readBinary(): Promise<ArrayBuffer> { return new ArrayBuffer(0); },
    async writeBinary(): Promise<void> { /* no-op */ },
    async stat(): Promise<{ size: number; mtime: number } | null> { return null; },
    async list(): Promise<{ files: string[]; folders: string[] }> { return { files: [], folders: [] }; },
  } as unknown as FakeAdapter;
}
