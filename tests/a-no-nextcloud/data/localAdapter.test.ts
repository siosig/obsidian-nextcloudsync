import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { DataAdapter, TFile, Vault } from 'obsidian';

function makeAdapter(files: Record<string, string> = {}): DataAdapter {
  const store = { ...files };
  return {
    read: jest.fn(async (p: string) => store[p] ?? ''),
    write: jest.fn(async (p: string, d: string) => { store[p] = d; }),
    readBinary: jest.fn(),
    writeBinary: jest.fn(async () => {}),
    exists: jest.fn(async (p: string) => p in store),
    remove: jest.fn(async (p: string) => { delete store[p]; }),
    rename: jest.fn(async (from: string, to: string) => { store[to] = store[from]; delete store[from]; }),
    mkdir: jest.fn(async () => {}),
    stat: jest.fn(),
    list: jest.fn(),
  } as unknown as DataAdapter;
}

describe('LocalAdapter', () => {
  describe('IgnoreList', () => {
    it('keeps the entry across repeated checks within the window (one write fires several events)', () => {
      jest.useFakeTimers();
      const adapter = new LocalAdapter(makeAdapter());
      adapter.ignore('Notes/test.md');
      expect(adapter.shouldIgnore('Notes/test.md')).toBe(true);
      expect(adapter.shouldIgnore('Notes/test.md')).toBe(true); // NOT consumed: create/delete/rename all check it
      jest.useRealTimers();
    });

    it('expires the entry after the ignore window', () => {
      jest.useFakeTimers();
      const adapter = new LocalAdapter(makeAdapter());
      adapter.ignore('Notes/test.md');
      jest.advanceTimersByTime(5001);
      expect(adapter.shouldIgnore('Notes/test.md')).toBe(false);
      jest.useRealTimers();
    });

    it('returns false for paths not in ignore list', () => {
      const adapter = new LocalAdapter(makeAdapter());
      expect(adapter.shouldIgnore('Notes/unknown.md')).toBe(false);
    });

    it('resets timer on re-registration', () => {
      jest.useFakeTimers();
      const adapter = new LocalAdapter(makeAdapter());
      adapter.ignore('file.md');
      adapter.ignore('file.md'); // re-register resets timer
      expect(adapter.shouldIgnore('file.md')).toBe(true);
      jest.useRealTimers();
    });

    it('dispose clears all pending entries and their timers', () => {
      jest.useFakeTimers();
      const adapter = new LocalAdapter(makeAdapter());
      adapter.ignore('a.md');
      adapter.ignore('b.md');
      adapter.dispose();
      expect(adapter.shouldIgnore('a.md')).toBe(false);
      expect(adapter.shouldIgnore('b.md')).toBe(false);
      jest.useRealTimers();
    });
  });

  describe('atomicWrite', () => {
    it('writes to tmp then renames', async () => {
      const raw = makeAdapter();
      const adapter = new LocalAdapter(raw);
      await adapter.atomicWrite('Notes/hello.md', 'content');
      expect(raw.write).toHaveBeenCalledWith(
        expect.stringContaining('.nextcloudsync.tmp'),
        'content',
      );
      expect(raw.rename).toHaveBeenCalled();
    });

    it('ensures parent directory before writing', async () => {
      const raw = makeAdapter();
      const adapter = new LocalAdapter(raw);
      await adapter.atomicWrite('a/b/c/file.md', 'content');
      expect(raw.mkdir).toHaveBeenCalledWith('a/b/c');
    });

    it('cleans up tmp file on write failure', async () => {
      const raw = makeAdapter();
      (raw.write as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
      const adapter = new LocalAdapter(raw);
      await expect(adapter.atomicWrite('Notes/fail.md', 'x')).rejects.toThrow('disk full');
    });
  });

  describe('LocalAdapter.listVaultFiles', () => {
    // At runtime moduleNameMapper resolves 'obsidian' to the mock TFile (which accepts stat).
    // TypeScript sees the real obsidian.d.ts TFile (no public constructor), so we cast to
    // allow construction in tests — the same pattern used in SyncEngine.deletion.test.ts.
    type MockTFileCtor = new (path: string, stat?: { ctime?: number; mtime?: number; size?: number }) => TFile;
    const MockTFile = TFile as unknown as MockTFileCtor;

    function makeVault(files: TFile[]): Vault {
      return {
        adapter: makeAdapter(),
        getAbstractFileByPath: jest.fn(),
        getFiles: jest.fn(() => files),
        trash: jest.fn(),
      } as unknown as Vault;
    }

    it('returns path/size/mtime from the Vault cache without touching the adapter', () => {
      const vault = makeVault([
        new MockTFile('Notes/a.md', { mtime: 111, size: 10 }),
        new MockTFile('メモ/b.md', { mtime: 222, size: 20 }),
      ]);
      const la = new LocalAdapter(vault.adapter, vault);
      const entries = la.listVaultFiles();
      expect(entries).toEqual([
        { path: 'Notes/a.md', size: 10, mtime: 111 },
        { path: 'メモ/b.md', size: 20, mtime: 222 },
      ]);
      expect(vault.getFiles).toHaveBeenCalledTimes(1);
    });

    it('returns an empty array when no Vault is injected (back-compat)', () => {
      const la = new LocalAdapter(makeAdapter());
      expect(la.listVaultFiles()).toEqual([]);
    });
  });

  describe('atomicWriteBinary', () => {
    it('ensures parent directory before writing binary', async () => {
      const raw = makeAdapter();
      const adapter = new LocalAdapter(raw);
      await adapter.atomicWriteBinary('03_news/images/file.svg', new ArrayBuffer(4));
      expect(raw.mkdir).toHaveBeenCalledWith('03_news/images');
    });

    it('does not call mkdir for root-level files', async () => {
      const raw = makeAdapter();
      const adapter = new LocalAdapter(raw);
      await adapter.atomicWriteBinary('file.svg', new ArrayBuffer(4));
      expect(raw.mkdir).not.toHaveBeenCalled();
    });
  });
});
