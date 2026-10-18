import { DataAdapter } from 'obsidian';
import { FileTimes, LocalAdapter } from '../../../src/data/LocalAdapter';

const BIRTH = 1_646_092_800_000;
const MTIME = 1_577_808_000_000;

// Matches the real iPhone failure: applying mtime after ctime clamps birthtime.
// Separate native setters allow creation time to be restored after modification time.
function filesystem(bridge: 'mobile' | 'desktop' | 'none') {
  const files = new Map<string, { body: ArrayBuffer; ctime: number; mtime: number }>();
  const adapter = {
    stat: async (p: string) => {
      const f = files.get(p);
      return f ? { type: 'file', size: f.body.byteLength, ctime: f.ctime, mtime: f.mtime } : null;
    },
    exists: async (p: string) => files.has(p),
    mkdir: async () => undefined,
    readBinary: async (p: string) => files.get(p)!.body,
    writeBinary: async (p: string, body: ArrayBuffer, times: FileTimes = {}) => {
      files.set(p, { body, ctime: Math.min(times.ctime ?? Date.now(), times.mtime ?? Date.now()),
        mtime: times.mtime ?? Date.now() });
    },
    write: async (p: string, text: string, times: FileTimes = {}) => {
      await adapter.writeBinary(p, new TextEncoder().encode(text).buffer as ArrayBuffer, times);
    },
    remove: async (p: string) => { files.delete(p); },
    rename: async (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a); },
    getFullPath: (p: string) => p,
    ...(bridge === 'mobile' ? { fs: { setTimes: async (p: string, ctime?: number, mtime?: number) => {
      const file = files.get(p)!;
      if (ctime != null) file.ctime = ctime;
      if (mtime != null) { file.mtime = mtime; file.ctime = Math.min(file.ctime, mtime); }
    } } } : {}),
    ...(bridge === 'desktop' ? { btime: (p: string, value: number) => { files.get(p)!.ctime = value; } } : {}),
  };
  return { files, local: new LocalAdapter(adapter as unknown as DataAdapter) };
}

describe('creation time later than modification time', () => {
  it.each(['mobile', 'desktop'] as const)('preserves both times on %s binary downloads', async (bridge) => {
    const h = filesystem(bridge);
    await h.local.atomicWriteBinary('note.bin', new Uint8Array([1, 2, 3]).buffer,
      { ctime: BIRTH, mtime: MTIME });
    expect(await h.local.stat('note.bin')).toMatchObject({ ctime: BIRTH, mtime: MTIME, size: 3 });
    expect(new Uint8Array(h.files.get('note.bin')!.body)).toEqual(new Uint8Array([1, 2, 3]));
    h.local.dispose();
  });

  it('preserves both times on text writes', async () => {
    const h = filesystem('mobile');
    await h.local.atomicWrite('note.md', 'unchanged bytes', { ctime: BIRTH, mtime: MTIME });
    expect(await h.local.stat('note.md')).toMatchObject({ ctime: BIRTH, mtime: MTIME });
    expect(new TextDecoder().decode(h.files.get('note.md')!.body)).toBe('unchanged bytes');
    h.local.dispose();
  });

  it('repairs a creation-time-only change without changing content or mtime', async () => {
    const h = filesystem('mobile');
    h.files.set('note.md', { body: new Uint8Array([1, 2, 3]).buffer, ctime: MTIME, mtime: MTIME });
    await h.local.setFileTimes('note.md', { ctime: BIRTH });
    expect(await h.local.stat('note.md')).toMatchObject({ ctime: BIRTH, mtime: MTIME });
    expect(new Uint8Array(h.files.get('note.md')!.body)).toEqual(new Uint8Array([1, 2, 3]));
    h.local.dispose();
  });

  it('rejects an adapter that silently clamps birthtime and has no repair capability', async () => {
    const h = filesystem('none');
    await expect(h.local.atomicWriteBinary('note.bin', new ArrayBuffer(3), { ctime: BIRTH, mtime: MTIME }))
      .rejects.toThrow('Filesystem did not preserve');
    h.local.dispose();
  });
});
