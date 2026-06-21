import { ensureParentFolder } from '../../../src/util/ensureParentFolder';

/**
 * Adapter that models Obsidian's real constraint: `write` to a path inside a folder that
 * does not yet exist throws (ENOENT), and folders only come into being via `mkdir`.
 */
function realisticAdapter() {
  const folders = new Set<string>(['']); // vault root always exists
  return {
    folders,
    exists: jest.fn(async (p: string) => folders.has(p)),
    mkdir: jest.fn(async (p: string) => { folders.add(p); }),
  };
}

describe('ensureParentFolder', () => {
  it('creates the parent folder when it does not exist', async () => {
    const a = realisticAdapter();
    await ensureParentFolder(a as never, '_logs/nextcloud-sync_debug_host.txt');
    expect(a.mkdir).toHaveBeenCalledWith('_logs');
    expect(a.folders.has('_logs')).toBe(true);
  });

  it('does not call mkdir when the parent folder already exists', async () => {
    const a = realisticAdapter();
    a.folders.add('_logs');
    await ensureParentFolder(a as never, '_logs/nextcloud-sync_debug_host.txt');
    expect(a.mkdir).not.toHaveBeenCalled();
  });

  it('is a no-op for a vault-root path (no parent folder)', async () => {
    const a = realisticAdapter();
    await ensureParentFolder(a as never, 'nextcloud-sync_debug_host.txt');
    expect(a.mkdir).not.toHaveBeenCalled();
  });
});
