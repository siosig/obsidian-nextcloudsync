import { FrontmatterMergeStrategy } from '../../../src/sync/merge/FrontmatterMergeStrategy';
import { MergeEngine } from '../../../src/sync/merge/MergeEngine';
import { MergeContext } from '../../../src/types';

// MergeEngine needs these for body merging (tests that exercise the full engine)
jest.mock('reconcile-text', () => ({
  reconcile: (base: string, local: string, remote: string) => {
    const text = local === remote ? local : local + remote;
    return { text, cursors: [] };
  },
}));

jest.mock('node-diff3', () => ({
  diff3Merge: (a: string[], _o: string[], b: string[], _opts: unknown) => {
    const hasConflict = JSON.stringify(a) !== JSON.stringify(b);
    return hasConflict ? [{ conflict: { a, b } }] : [{ ok: a }];
  },
}));

function fm(...lines: string[]): string {
  return `---\n${lines.join('\n')}\n---`;
}

// ─── US4: no-frontmatter passthrough ─────────────────────────────────────────

describe('FrontmatterMergeStrategy – no frontmatter (US4)', () => {
  const strategy = new FrontmatterMergeStrategy();

  it('returns success=false when both sides have no frontmatter', () => {
    const result = strategy.merge('', '', '');
    expect(result.success).toBe(false);
  });

  it('MergeEngine: notes without frontmatter merge only the body (unchanged behaviour)', () => {
    const engine = new MergeEngine({ maxConflictRegions: 0 });
    const base = 'Hello world';
    const local = 'Hello world local';
    const remote = 'Hello world local';
    const result = engine.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(result.mergedContent).not.toContain('---');
  });
});

// ─── US1: array union merge ───────────────────────────────────────────────────

describe('FrontmatterMergeStrategy – array union (US1)', () => {
  const strategy = new FrontmatterMergeStrategy();
  const base = fm('tags:\n  - work');

  it('merges two distinct tag arrays into a union (local order first)', () => {
    const local = fm('tags:\n  - work');
    const remote = fm('tags:\n  - ideas');
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('work');
    expect(result.frontmatter).toContain('ideas');
  });

  it('one side adds a tag, other unchanged → tag appears once', () => {
    const local = fm('tags:\n  - work\n  - newTag');
    const remote = fm('tags:\n  - work');
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    const count = (result.frontmatter.match(/newTag/g) || []).length;
    expect(count).toBe(1);
    expect(result.frontmatter).toContain('work');
  });

  it('both sides add the same tag → appears exactly once', () => {
    const local = fm('tags:\n  - work\n  - shared');
    const remote = fm('tags:\n  - work\n  - shared');
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    const count = (result.frontmatter.match(/shared/g) || []).length;
    expect(count).toBe(1);
  });

  it('empty array on one side merged with populated array', () => {
    const base2 = fm('tags: []');
    const local = fm('tags:\n  - alpha\n  - beta');
    const remote = fm('tags: []');
    const result = strategy.merge(base2, local, remote);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('alpha');
    expect(result.frontmatter).toContain('beta');
  });

  it('aliases union-merge the same way as tags', () => {
    const aliasBase = fm('aliases:\n  - doc1');
    const local = fm('aliases:\n  - doc1\n  - alias2');
    const remote = fm('aliases:\n  - doc1\n  - alias3');
    const result = strategy.merge(aliasBase, local, remote);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('alias2');
    expect(result.frontmatter).toContain('alias3');
  });
});

// ─── YAML parse failure fallback ──────────────────────────────────────────────

describe('FrontmatterMergeStrategy – YAML parse failure fallback', () => {
  const strategy = new FrontmatterMergeStrategy();

  it('returns success=false on malformed YAML so caller can use diff3', () => {
    // { unclosed flow mapping → js-yaml throws
    const bad = '---\n{ unclosed: yaml\n---';
    const good = fm('tags:\n  - work');
    const result = strategy.merge('', bad, good);
    expect(result.success).toBe(false);
    expect(result.frontmatter).toBe('');
  });
});

// ─── US2: scalar auto-resolve ─────────────────────────────────────────────────

describe('FrontmatterMergeStrategy – scalar auto-resolve (US2)', () => {
  const strategy = new FrontmatterMergeStrategy();

  it('only local changed scalar → local value wins', () => {
    const base = fm('title: Old');
    const local = fm('title: New');
    const remote = fm('title: Old');
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('New');
    expect(result.frontmatter).not.toContain('Old');
  });

  it('only remote changed scalar → remote value wins', () => {
    const base = fm('status: draft');
    const local = fm('status: draft');
    const remote = fm('status: published');
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('published');
    expect(result.frontmatter).not.toContain('draft');
  });

  it('both sides changed scalar to same value → value appears exactly once', () => {
    const base = fm('title: Old');
    const local = fm('title: Same');
    const remote = fm('title: Same');
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    const count = (result.frontmatter.match(/Same/g) || []).length;
    expect(count).toBe(1);
  });

  it('key present only on local → key appears in result', () => {
    const base = fm('title: Hello');
    const local = fm('title: Hello\nlocalOnly: yes');
    const remote = fm('title: Hello');
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('localOnly');
  });

  it('key present only on remote → key appears in result', () => {
    const base = fm('title: Hello');
    const local = fm('title: Hello');
    const remote = fm('title: Hello\nremoteOnly: yes');
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('remoteOnly');
  });

  it('key deleted on both sides → key absent from result', () => {
    const base = fm('title: Hello\ntoDelete: gone');
    const local = fm('title: Hello');
    const remote = fm('title: Hello');
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(result.frontmatter).not.toContain('toDelete');
  });

  it('nested YAML object treated as scalar (option A): changed on one side wins', () => {
    const base = fm('meta:\n  author: Alice\n  version: 1');
    const local = fm('meta:\n  author: Bob\n  version: 1');
    const remote = fm('meta:\n  author: Alice\n  version: 1');
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('Bob');
  });
});

// ─── US3: scalar conflict policy ─────────────────────────────────────────────

describe('FrontmatterMergeStrategy – scalar conflict policy (US3)', () => {
  const strategy = new FrontmatterMergeStrategy();
  const base = fm('status: draft');
  const local = fm('status: done');
  const remote = fm('status: in-review');

  it('policy latest-mtime, local newer → local value wins', () => {
    const ctx: MergeContext = { frontmatterScalarPolicy: 'latest-mtime', localMtime: 2000, remoteMtime: 1000 };
    const result = strategy.merge(base, local, remote, ctx);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('done');
    expect(result.frontmatter).not.toContain('in-review');
  });

  it('policy latest-mtime, remote newer → remote value wins', () => {
    const ctx: MergeContext = { frontmatterScalarPolicy: 'latest-mtime', localMtime: 1000, remoteMtime: 2000 };
    const result = strategy.merge(base, local, remote, ctx);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('in-review');
    expect(result.frontmatter).not.toContain('done');
  });

  it('policy latest-mtime, mtime tie → remote wins', () => {
    const ctx: MergeContext = { frontmatterScalarPolicy: 'latest-mtime', localMtime: 1000, remoteMtime: 1000 };
    const result = strategy.merge(base, local, remote, ctx);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('in-review');
  });

  it('policy remote-win → remote always wins', () => {
    const ctx: MergeContext = { frontmatterScalarPolicy: 'remote-win', localMtime: 9999, remoteMtime: 0 };
    const result = strategy.merge(base, local, remote, ctx);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('in-review');
    expect(result.frontmatter).not.toContain('done');
  });

  it('policy local-win → local always wins', () => {
    const ctx: MergeContext = { frontmatterScalarPolicy: 'local-win', localMtime: 0, remoteMtime: 9999 };
    const result = strategy.merge(base, local, remote, ctx);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('done');
    expect(result.frontmatter).not.toContain('in-review');
  });

  it('no ctx supplied → remote wins (safe default)', () => {
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('in-review');
    expect(result.frontmatter).not.toContain('done');
  });
});

// ─── MergeEngine integration: frontmatter is merged semantically ──────────────

describe('MergeEngine – frontmatter semantic merge integration', () => {
  const engine = new MergeEngine({ maxConflictRegions: 0 });

  it('tags on both sides union-merge instead of conflicting', () => {
    const base = '---\ntags:\n  - work\n---\nBody';
    const local = '---\ntags:\n  - work\n  - local-tag\n---\nBody';
    const remote = '---\ntags:\n  - work\n  - remote-tag\n---\nBody';
    const result = engine.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(result.mergedContent).toContain('local-tag');
    expect(result.mergedContent).toContain('remote-tag');
    expect(result.hadConflicts).toBe(false);
  });

  it('scalar field changed only on local auto-resolves to local', () => {
    const base = '---\ntitle: Old\n---\nBody';
    const local = '---\ntitle: New\n---\nBody';
    const remote = '---\ntitle: Old\n---\nBody';
    const result = engine.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(result.mergedContent).toContain('New');
    expect(result.mergedContent).not.toContain('Old');
  });

  it('passes MergeContext policy to FrontmatterMergeStrategy', () => {
    const base = '---\nstatus: draft\n---\nBody';
    const local = '---\nstatus: done\n---\nBody';
    const remote = '---\nstatus: in-review\n---\nBody';
    const ctx: MergeContext = { frontmatterScalarPolicy: 'local-win', localMtime: 0, remoteMtime: 9999 };
    const result = engine.merge(base, local, remote, ctx);
    expect(result.success).toBe(true);
    expect(result.mergedContent).toContain('done');
    expect(result.mergedContent).not.toContain('in-review');
  });
});
