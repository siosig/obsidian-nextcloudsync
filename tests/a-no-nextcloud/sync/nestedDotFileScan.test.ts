import { LocalScanner } from '../../../src/sync/scan/LocalScanner';
import { LocalAdapter } from '../../../src/data/LocalAdapter';

test('desktop discovers a hidden backup inside visible folders without statting cached normal files', async () => {
  const stat = jest.fn(async () => ({size: 7, mtime: 2000, ctime: 1000}));
  const list = jest.fn(async (p: string) => ({
    '': {files: [], folders: ['Projects', '.git']},
    Projects: {files: ['Projects/note.md'], folders: ['Projects/assets']},
    'Projects/assets': {files: ['Projects/assets/.backup'], folders: []},
  }[p] ?? {files: [], folders: []}));
  const scanner = new LocalScanner({localAdapter: {listVaultFiles: () => [{path: 'Projects/note.md', size: 5, mtime: 2}], list, stat} as unknown as LocalAdapter,
    isSystemExcluded: p => p.startsWith('.git'), isUnderConfigDir: p => p.startsWith('.obsidian'), enumerateIncludedConfigPaths: async () => []});
  const files = await scanner.scanLocalFiles();
  expect(files.get('Projects/assets/.backup')).toEqual({size: 7, mtime: 2000, ctime: 1000});
  expect(stat).not.toHaveBeenCalledWith('Projects/note.md');
  expect(list).not.toHaveBeenCalledWith('.git');
});
