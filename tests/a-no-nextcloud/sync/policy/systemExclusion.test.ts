// Direct tests for the system-exclusion rules (feature 074, Phase 1).
//
// No [SPEC:...] tags here — see the note at the top of localUnchanged.test.ts.
//
// isSystemExcluded is not only a "don't upload this" filter: every server-driven deletion consults
// it before anything reaches a raw filesystem remove. A server that fabricates a deletion for
// `.obsidian/plugins/...` is stopped here and nowhere else, which is why the precedence between the
// rules is worth pinning directly instead of only through an engine.
import { isSystemExcluded, SystemExclusionContext } from '../../../../src/sync/policy';
import { DIR_BREAKER_REPORT_FILENAME, FILE_BREAKER_REPORT_FILENAME } from '../../../../src/ui/breakerReport';

/** A context that excludes nothing of its own — every `true` below then comes from a rule, not setup. */
function ctx(over: Partial<SystemExclusionContext> = {}): SystemExclusionContext {
  return {
    excludedFolders: [],
    isUnderConfigDir: () => false,
    isConfigPathIncluded: () => false,
    ...over,
  };
}

describe('isSystemExcluded — the plugin\'s own artefacts', () => {
  it('excludes atomic-write temp files, current and legacy suffix', () => {
    expect(isSystemExcluded('notes/a.md.ncs.tmp', ctx())).toBe(true);
    expect(isSystemExcluded('notes/a.md.nextcloudsync.tmp', ctx())).toBe(true);
  });

  it('excludes the mass-delete breaker reports at the vault root', () => {
    expect(isSystemExcluded(DIR_BREAKER_REPORT_FILENAME, ctx())).toBe(true);
    expect(isSystemExcluded(FILE_BREAKER_REPORT_FILENAME, ctx())).toBe(true);
  });

  it('matches the breaker reports by exact path, not by name anywhere in the vault', () => {
    // A user's own note that happens to sit in a folder of the same name is ordinary content.
    expect(isSystemExcluded(`archive/${DIR_BREAKER_REPORT_FILENAME}`, ctx())).toBe(false);
  });

  it('excludes this device\'s log only while its output toggle says so', () => {
    const active = ctx({ isActiveLogFile: (p) => p === 'logs/thisdevice.md' });
    expect(isSystemExcluded('logs/thisdevice.md', active)).toBe(true);
    // Another device's log is not written here, so it stays ordinary syncable content.
    expect(isSystemExcluded('logs/otherdevice.md', active)).toBe(false);
    // The hook is optional: a context without it must not throw.
    expect(isSystemExcluded('logs/thisdevice.md', ctx())).toBe(false);
  });
});

describe('isSystemExcluded — hard-excluded machine folders', () => {
  it('excludes .git and .trash and everything beneath them', () => {
    expect(isSystemExcluded('.git', ctx())).toBe(true);
    expect(isSystemExcluded('.git/objects/ab/cdef', ctx())).toBe(true);
    expect(isSystemExcluded('.trash', ctx())).toBe(true);
    expect(isSystemExcluded('.trash/deleted.md', ctx())).toBe(true);
  });

  it('does not catch names that merely start with the same characters', () => {
    // The match is a path-segment prefix, so `.github` and `.gitignore` are ordinary vault content.
    expect(isSystemExcluded('.github/workflows/ci.yml', ctx())).toBe(false);
    expect(isSystemExcluded('.gitignore', ctx())).toBe(false);
    expect(isSystemExcluded('.trashcan/note.md', ctx())).toBe(false);
  });

  it('leaves other root-level dot content syncable', () => {
    expect(isSystemExcluded('.hidden-notes/idea.md', ctx())).toBe(false);
  });
});

describe('isSystemExcluded — the user\'s excluded folders', () => {
  it('excludes a configured folder and its subtree', () => {
    const c = ctx({ excludedFolders: ['Archive'] });
    expect(isSystemExcluded('Archive', c)).toBe(true);
    expect(isSystemExcluded('Archive/2020/old.md', c)).toBe(true);
    expect(isSystemExcluded('Archived/still-mine.md', c)).toBe(false);
  });

  it('applies to ordinary vault files, not just config paths', () => {
    expect(isSystemExcluded('Scratch/tmp.md', ctx({ excludedFolders: ['Scratch'] }))).toBe(true);
  });
});

describe('isSystemExcluded — the config folder', () => {
  const underConfig = { isUnderConfigDir: (p: string) => p.startsWith('.obsidian') };

  it('excludes a config path that no enabled category includes', () => {
    expect(isSystemExcluded('.obsidian/workspace.json', ctx({
      ...underConfig, isConfigPathIncluded: () => false,
    }))).toBe(true);
  });

  it('syncs a config path an enabled category includes', () => {
    expect(isSystemExcluded('.obsidian/bookmarks.json', ctx({
      ...underConfig, isConfigPathIncluded: (p) => p.endsWith('bookmarks.json'),
    }))).toBe(false);
  });

  it('never consults the config resolver for ordinary vault files', () => {
    const isConfigPathIncluded = jest.fn(() => false);
    expect(isSystemExcluded('notes/a.md', ctx({ ...underConfig, isConfigPathIncluded }))).toBe(false);
    expect(isConfigPathIncluded).not.toHaveBeenCalled();
  });
});

describe('isSystemExcluded — precedence, as the remote-deletion scope guard relies on it', () => {
  it('keeps .git excluded even if the config resolver would include it', () => {
    // Order matters: a resolver that said yes to everything must not be able to unlock a repo.
    expect(isSystemExcluded('.git/config', ctx({
      isUnderConfigDir: () => true, isConfigPathIncluded: () => true,
    }))).toBe(true);
  });

  it('keeps a hard exclusion in force regardless of the user\'s list being empty', () => {
    expect(isSystemExcluded('.trash/x.md', ctx({ excludedFolders: [] }))).toBe(true);
  });

  it('protects community plugins, which the resolver reports as never included', () => {
    expect(isSystemExcluded('.obsidian/plugins/some-plugin/main.js', ctx({
      isUnderConfigDir: () => true, isConfigPathIncluded: () => false,
    }))).toBe(true);
  });

  it('tolerates a missing excludedFolders list rather than throwing on it', () => {
    // Callers build this context from settings that older installs may not carry.
    expect(isSystemExcluded('notes/a.md', ctx({
      excludedFolders: undefined as unknown as readonly string[],
    }))).toBe(false);
  });
});
