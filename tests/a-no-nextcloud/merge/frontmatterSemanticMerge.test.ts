import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { getFrontMatterInfo, parseYaml } from 'obsidian';
import { FrontmatterMergeStrategy } from '../../../src/sync/merge/FrontmatterMergeStrategy';
import { MergeEngine } from '../../../src/sync/merge/MergeEngine';
import { MergeContext } from '../../../src/types';

/** Parse the `tags` value out of a resolved `---`-wrapped frontmatter block. */
function tagsOf(frontmatter: string): unknown {
  const info = getFrontMatterInfo(frontmatter);
  const obj = parseYaml(info.frontmatter) as Record<string, unknown> | null;
  return obj?.tags;
}

/** True when any line is a plugin conflict-marker line. */
function hasMarkerLines(s: string): boolean {
  return /^(?:<<<<<<<|=======|>>>>>>>)/m.test(s);
}

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

  it('[SPEC:HFM-2] base-aware set merge: remote replaced the only tag, local unchanged → replacement wins (043 supersedes blind union)', () => {
    // base [work]; local keeps work; remote deleted work + added ideas. Under the base-aware set 3-way
    // the remote deletion of `work` propagates (feature 043 replaced feature 040's blind union, which
    // would have kept both). This is the deletion-propagation the whole feature exists to deliver.
    const local = fm('tags:\n  - work');
    const remote = fm('tags:\n  - ideas');
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(tagsOf(result.frontmatter)).toEqual(['ideas']);
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

  it('[SPEC:HFM-7] an unparseable side makes merge return success:false with empty (never marker-laden) frontmatter', () => {
    // { unclosed flow mapping → parseYaml throws. Feature 043: success:false means ONLY "caller must
    // pick a whole side per policy" — it is NOT a signal to text-diff, so the returned frontmatter is
    // empty and can never carry conflict-marker lines.
    const bad = '---\n{ unclosed: yaml\n---';
    const good = fm('tags:\n  - work');
    const result = strategy.merge('', bad, good);
    expect(result.success).toBe(false);
    expect(result.frontmatter).toBe('');
    expect(hasMarkerLines(result.frontmatter)).toBe(false);
    // Symmetric: unparseable on the OTHER side is handled identically.
    const flipped = strategy.merge('', good, bad);
    expect(flipped.success).toBe(false);
    expect(flipped.frontmatter).toBe('');
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

// ─── HFM-6: scalar conflict via existing policy; nested objects stay opaque ───

describe('FrontmatterMergeStrategy – scalar policy + nested-object opacity (HFM-6)', () => {
  const strategy = new FrontmatterMergeStrategy();

  it('[SPEC:HFM-6] a both-sides scalar conflict is decided by the existing frontmatterScalarConflictPolicy (no new knob)', () => {
    // Both sides changed `status` to different values → policy decides. remote-win vs local-win must
    // flip the winner purely from the existing scalar policy field, proving no behaviour was added.
    const base = fm('status: draft');
    const local = fm('status: done');
    const remote = fm('status: in-review');
    const remoteWin = strategy.merge(base, local, remote, { frontmatterScalarPolicy: 'remote-win', localMtime: 0, remoteMtime: 0 });
    expect(remoteWin.success).toBe(true);
    expect(remoteWin.frontmatter).toContain('in-review');
    expect(remoteWin.frontmatter).not.toContain('done');
    const localWin = strategy.merge(base, local, remote, { frontmatterScalarPolicy: 'local-win', localMtime: 0, remoteMtime: 0 });
    expect(localWin.frontmatter).toContain('done');
    expect(localWin.frontmatter).not.toContain('in-review');
  });

  it('[SPEC:HFM-6] a nested YAML object is treated as an opaque scalar, resolved whole by policy — never partially merged', () => {
    // meta is a mapping on all three sides. Both sides changed it differently → it must be picked WHOLE
    // by the scalar policy (option A opacity), NOT field-by-field merged. remote-win → remote's meta wins
    // intact; local's divergent inner value must be absent.
    const base = fm('meta:\n  author: Alice\n  version: 1');
    const local = fm('meta:\n  author: Bob\n  version: 1');
    const remote = fm('meta:\n  author: Carol\n  version: 2');
    const result = strategy.merge(base, local, remote, { frontmatterScalarPolicy: 'remote-win', localMtime: 0, remoteMtime: 0 });
    expect(result.success).toBe(true);
    expect(result.frontmatter).toContain('Carol');
    expect(result.frontmatter).toContain('version: 2');
    // Opaque whole-value pick: the losing side's inner author is not spliced in.
    expect(result.frontmatter).not.toContain('Bob');
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

// ─── Feature 043: base-aware SET 3-way for list fields ─────────────────────────

describe('FrontmatterMergeStrategy – base-aware set merge (feature 043)', () => {
  const strategy = new FrontmatterMergeStrategy();

  it('[SPEC:HFM-2] propagates a remote deletion (base [1,2,3], local unchanged, remote [2,3,4] → [2,3,4])', () => {
    const base = fm("tags: ['1', '2', '3']");
    const local = fm("tags: ['1', '2', '3']");
    const remote = fm("tags: ['2', '3', '4']");
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    // '1' deleted by remote (local untouched) → gone; '4' added by remote → present.
    expect(tagsOf(result.frontmatter)).toEqual(['2', '3', '4']);
  });

  it('[SPEC:HFM-2] additions from both sides are kept without duplication (base [a], local +b, remote +c → [a,b,c])', () => {
    const base = fm("tags: ['a']");
    const local = fm("tags: ['a', 'b']");
    const remote = fm("tags: ['a', 'c']");
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(tagsOf(result.frontmatter)).toEqual(['a', 'b', 'c']);
  });

  it('[SPEC:HFM-2] both-delete and one-side-delete both leave the item absent', () => {
    // both delete b: base [a,b], local [a], remote [a] → [a]
    const rBoth = strategy.merge(fm("tags: ['a', 'b']"), fm("tags: ['a']"), fm("tags: ['a']"));
    expect(rBoth.success).toBe(true);
    expect(tagsOf(rBoth.frontmatter)).toEqual(['a']);

    // one-side delete b (other == base): base [a,b], local [a] (deleted), remote [a,b] (kept) → [a]
    const rOne = strategy.merge(fm("tags: ['a', 'b']"), fm("tags: ['a']"), fm("tags: ['a', 'b']"));
    expect(rOne.success).toBe(true);
    expect(tagsOf(rOne.frontmatter)).toEqual(['a']);
  });

  it('[SPEC:HFM-4] variant spellings (#tag / tag, surrounding whitespace) collapse to one normalized entry', () => {
    const base = fm('tags: []');
    const local = fm("tags: ['#project', ' work ']");
    const remote = fm("tags: ['project', 'work']");
    const result = strategy.merge(base, local, remote);
    expect(result.success).toBe(true);
    expect(tagsOf(result.frontmatter)).toEqual(['project', 'work']);
    expect(result.frontmatter).not.toContain('#project');
  });

  it('[SPEC:HFM-3] with no base, list fields fall back to a deduplicated union (deletions undetectable)', () => {
    const local = fm("tags: ['a', 'b']");
    const remote = fm("tags: ['b', 'c']");
    const result = strategy.merge('', local, remote);
    expect(result.success).toBe(true);
    expect(tagsOf(result.frontmatter)).toEqual(['a', 'b', 'c']);
    expect(hasMarkerLines(result.frontmatter)).toBe(false);
  });

  it('[SPEC:HFM-5] output order is stable (base order first, then additions) and deterministic', () => {
    const base = fm("tags: ['z', 'y', 'x']");
    const local = fm("tags: ['z', 'y', 'x', 'l']");
    const remote = fm("tags: ['z', 'y', 'x', 'r']");
    const r1 = strategy.merge(base, local, remote);
    const r2 = strategy.merge(base, local, remote);
    expect(r1.success).toBe(true);
    // base order preserved (NOT alphabetized), then local addition, then remote addition.
    expect(tagsOf(r1.frontmatter)).toEqual(['z', 'y', 'x', 'l', 'r']);
    // deterministic: no mtime dependence for arrays, identical output across runs.
    expect(r2.frontmatter).toBe(r1.frontmatter);
  });
});

// ─── HFM-1: production parses/serializes via Obsidian, never a directly-bundled YAML lib ───────

describe('Frontmatter merge production code – no raw js-yaml import (HFM-1)', () => {
  /** Recursively collect every .ts file under a directory. */
  function collect(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) collect(p, acc);
      else if (p.endsWith('.ts')) acc.push(p);
    }
    return acc;
  }

  it("[SPEC:HFM-1] no file under src/sync/merge imports 'js-yaml' (parse/serialize go through Obsidian's parseYaml/stringifyYaml)", () => {
    const mergeDir = resolve(__dirname, '..', '..', '..', 'src', 'sync', 'merge');
    const offenders = collect(mergeDir).filter((f) => /from\s+['"]js-yaml['"]|require\(\s*['"]js-yaml['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it("[SPEC:HFM-1] FrontmatterMergeStrategy imports parseYaml/stringifyYaml from 'obsidian'", () => {
    const src = readFileSync(resolve(__dirname, '..', '..', '..', 'src', 'sync', 'merge', 'FrontmatterMergeStrategy.ts'), 'utf8');
    expect(/import\s*\{[^}]*\bparseYaml\b[^}]*\}\s*from\s*['"]obsidian['"]/.test(src)).toBe(true);
    expect(/import\s*\{[^}]*\bstringifyYaml\b[^}]*\}\s*from\s*['"]obsidian['"]/.test(src)).toBe(true);
  });
});
