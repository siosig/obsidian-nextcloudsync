import { normalizeExcludedFolder, isUnderExcludedFolder, filterExcludableFolders } from '../../../src/util/excludedFolders';

describe('filterExcludableFolders (029 — Add suggestion pool)', () => {
  const all = ['Attachments', 'Attachments/Large media', 'Notes', 'Notes/Daily', '.git', 'Archive'];

  it('returns all candidate folders when the query is empty', () => {
    expect(filterExcludableFolders(all, [], '')).toEqual(all);
  });

  it('substring-matches case-insensitively against the path', () => {
    expect(filterExcludableFolders(all, [], 'att')).toEqual(['Attachments', 'Attachments/Large media']);
    expect(filterExcludableFolders(all, [], 'DAILY')).toEqual(['Notes/Daily']);
  });

  it('drops folders already excluded (the entry itself and anything nested under it)', () => {
    expect(filterExcludableFolders(all, ['Attachments'], '')).toEqual(['Notes', 'Notes/Daily', '.git', 'Archive']);
  });

  it('never offers the vault root or empty entries', () => {
    expect(filterExcludableFolders(['/', '', 'Notes'], [], '')).toEqual(['Notes']);
  });

  it('normalizes candidate paths and de-dups', () => {
    expect(filterExcludableFolders(['Notes/', 'Archive\\Old', 'Notes'], [], '')).toEqual(['Notes', 'Archive/Old']);
  });
});

describe('normalizeExcludedFolder', () => {
  it('keeps already-clean vault-relative paths', () => {
    expect(normalizeExcludedFolder('.git')).toBe('.git');
    expect(normalizeExcludedFolder('Attachments/Large media')).toBe('Attachments/Large media');
  });

  it('trims whitespace and strips leading/trailing slashes', () => {
    expect(normalizeExcludedFolder('  Attachments/  ')).toBe('Attachments');
    expect(normalizeExcludedFolder('/Attachments/')).toBe('Attachments');
  });

  it('strips a leading "./" and collapses repeated slashes', () => {
    expect(normalizeExcludedFolder('./Notes')).toBe('Notes');
    expect(normalizeExcludedFolder('a//b')).toBe('a/b');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizeExcludedFolder('Attachments\\sub')).toBe('Attachments/sub');
  });

  it('rejects whole-vault / empty inputs with null', () => {
    expect(normalizeExcludedFolder('')).toBeNull();
    expect(normalizeExcludedFolder('   ')).toBeNull();
    expect(normalizeExcludedFolder('/')).toBeNull();
    expect(normalizeExcludedFolder('.')).toBeNull();
    expect(normalizeExcludedFolder('./')).toBeNull();
  });
});

describe('isUnderExcludedFolder', () => {
  const folders = ['Attachments', '.git'];

  it('matches the entry itself and anything nested under it', () => {
    expect(isUnderExcludedFolder('Attachments', folders)).toBe(true);
    expect(isUnderExcludedFolder('Attachments/clip.mp4', folders)).toBe(true);
    expect(isUnderExcludedFolder('.git/config', folders)).toBe(true);
  });

  it('does not match across folder boundaries (no substring match)', () => {
    expect(isUnderExcludedFolder('Attachments-old/note.md', folders)).toBe(false);
    expect(isUnderExcludedFolder('AttachmentsX', folders)).toBe(false);
  });

  it('does not match unrelated paths', () => {
    expect(isUnderExcludedFolder('Notes/a.md', folders)).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isUnderExcludedFolder('attachments/x', folders)).toBe(false);
  });

  it('never excludes when the list is empty', () => {
    expect(isUnderExcludedFolder('anything/at/all.md', [])).toBe(false);
  });
});
