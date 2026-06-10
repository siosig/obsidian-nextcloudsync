import { LocalAdapter } from '../../src/data/LocalAdapter';
import { DataAdapter } from 'obsidian';

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
    it('registers and consumes ignore entry', () => {
      const adapter = new LocalAdapter(makeAdapter());
      adapter.ignore('Notes/test.md');
      expect(adapter.shouldIgnore('Notes/test.md')).toBe(true);
      expect(adapter.shouldIgnore('Notes/test.md')).toBe(false); // consumed
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
