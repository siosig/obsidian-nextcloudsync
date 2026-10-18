import { DataAdapter, Platform } from 'obsidian';
import { LocalAdapter, FileTimes } from '../../../src/data/LocalAdapter';

const BIRTH = 1_577_808_000_000;
const MTIME = 1_646_092_800_000;

function adapterDouble(ignoreBirthtime = false) {
  const files = new Map<string, { body: ArrayBuffer; ctime: number; mtime: number }>();
  const adapter = {
    stat: jest.fn(async (p: string) => {
      const f = files.get(p);
      return f ? { type: 'file', size: f.body.byteLength, ctime: f.ctime, mtime: f.mtime } : null;
    }),
    exists: jest.fn(async (p: string) => files.has(p)),
    mkdir: jest.fn(async () => undefined),
    readBinary: jest.fn(async (p: string) => files.get(p)!.body),
    writeBinary: jest.fn(async (p: string, body: ArrayBuffer, times?: FileTimes) => {
      files.set(p, { body, ctime: ignoreBirthtime ? Date.now() : (times?.ctime ?? Date.now()),
        mtime: times?.mtime ?? Date.now() });
    }),
    remove: jest.fn(async (p: string) => { files.delete(p); }),
    rename: jest.fn(async (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a); }),
  };
  return { adapter, local: new LocalAdapter(adapter as unknown as DataAdapter), files };
}

describe('mobile timestamp adapter contract (no native-device claim)', () => {
  const oldPlatform = { ...Platform };
  beforeEach(() => { Platform.isDesktopApp = false; Platform.isMobile = true; });
  afterEach(() => { Object.assign(Platform, oldPlatform); });

  it('passes both times through the mobile binary write adapter', async () => {
    const h = adapterDouble();
    await h.local.atomicWriteBinary('note.md', new ArrayBuffer(3), { ctime: BIRTH, mtime: MTIME });
    expect(h.adapter.writeBinary).toHaveBeenCalledWith(expect.any(String), expect.any(ArrayBuffer),
      { ctime: BIRTH, mtime: MTIME });
    expect(await h.local.stat('note.md')).toMatchObject({ ctime: BIRTH, mtime: MTIME });
    h.local.dispose();
  });

  it('preserves an existing creation time during a content rewrite', async () => {
    const h = adapterDouble();
    h.files.set('note.md', { body: new ArrayBuffer(1), ctime: BIRTH, mtime: MTIME });
    await h.local.atomicWriteBinary('note.md', new ArrayBuffer(2), { mtime: MTIME + 1000 });
    expect(await h.local.stat('note.md')).toMatchObject({ ctime: BIRTH, mtime: MTIME + 1000, size: 2 });
    h.local.dispose();
  });

  it('reports an unsupported native creation time rather than claiming timestamp convergence', async () => {
    const h = adapterDouble(true);
    h.files.set('note.md', { body: new ArrayBuffer(1), ctime: BIRTH, mtime: MTIME });
    await expect(h.local.setFileTimes('note.md', { ctime: BIRTH + 1000, mtime: MTIME }))
      .rejects.toThrow('Filesystem did not preserve');
    h.local.dispose();
  });
});
