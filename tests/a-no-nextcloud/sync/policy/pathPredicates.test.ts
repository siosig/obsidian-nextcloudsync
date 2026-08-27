// Direct tests for the small path predicates (feature 074, Phase 1).
//
// No [SPEC:...] tags here — see the note at the top of localUnchanged.test.ts.
//
// These three had no test naming them before the extraction. They are small, but each one is load
// bearing: parentDir keys the per-directory serialisation that avoids Nextcloud's 423 directory
// locks, isDotName gates the adapter walk that covers what Vault.getFiles() omits, and isTextEligible
// decides whether Compare offers a text diff at all.
import { parentDir, isDotName, isTextEligible } from '../../../../src/sync/policy';

describe('parentDir', () => {
  it('returns the empty string for a root-level file', () => {
    // Root-level files must all land on the same chain key, not on distinct ones.
    expect(parentDir('note.md')).toBe('');
  });

  it('returns the directory portion for a nested path', () => {
    expect(parentDir('a/note.md')).toBe('a');
    expect(parentDir('a/b/c/note.md')).toBe('a/b/c');
  });

  it('groups siblings onto one key and separates different directories', () => {
    expect(parentDir('a/one.md')).toBe(parentDir('a/two.md'));
    expect(parentDir('a/one.md')).not.toBe(parentDir('b/one.md'));
  });

  it('treats a trailing slash as naming the directory itself', () => {
    expect(parentDir('a/b/')).toBe('a/b');
  });
});

describe('isDotName', () => {
  it('looks at the last segment only', () => {
    expect(isDotName('.hidden')).toBe(true);
    expect(isDotName('a/.hidden')).toBe(true);
    // The parent being dot-prefixed does not make the child one.
    expect(isDotName('.config/visible.md')).toBe(false);
    expect(isDotName('a/visible.md')).toBe(false);
  });

  it('handles a bare root path', () => {
    expect(isDotName('note.md')).toBe(false);
    expect(isDotName('')).toBe(false);
  });
});

describe('isTextEligible', () => {
  const types = ['md', 'txt', 'json'];

  it('accepts a configured extension', () => {
    expect(isTextEligible('notes/a.md', types)).toBe(true);
    expect(isTextEligible('data/a.json', types)).toBe(true);
  });

  it('compares case-insensitively', () => {
    expect(isTextEligible('notes/A.MD', types)).toBe(true);
  });

  it('rejects an extension that is not configured', () => {
    expect(isTextEligible('img/a.png', types)).toBe(false);
  });

  it('rejects a file with no extension at all', () => {
    expect(isTextEligible('LICENSE', types)).toBe(false);
  });

  it('reads the extension after the last dot', () => {
    expect(isTextEligible('archive/notes.md.txt', types)).toBe(true);
    expect(isTextEligible('archive/notes.txt.png', types)).toBe(false);
  });

  it('treats a dotfile with no extension as ineligible', () => {
    // '.md' has its dot at index 0, so the segment after it is the whole name — this asserts what
    // the current rule does with it, since a leading-dot name is not an extension.
    expect(isTextEligible('.gitignore', types)).toBe(false);
  });

  it('accepts nothing when the configured list is empty', () => {
    expect(isTextEligible('notes/a.md', [])).toBe(false);
  });
});
