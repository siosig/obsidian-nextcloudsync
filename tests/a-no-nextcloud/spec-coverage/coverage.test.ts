// Machine-checkable spec coverage meta-test (US1).
// Statically scans EVERY test file (a / b-1 / b-2) for clause references — either a
// bare clause id embedded in the test name (e.g. "CF-2", "FR-019") or an explicit
// [SPEC:<id>] tag from specRef.ts — and cross-references the clause catalog.
//
//   uncovered (in-scope, no waiver, no test)  -> FAIL  (spec clause with no test)
//   unknown [SPEC:<id>] tag (not in catalog)  -> FAIL  (typo / missing catalog entry)
//   waived  (non-empty waiver)                -> reported as pending adjudication
//   covered                                   -> ok
//
// Runs in classification "a" (no Nextcloud, no UI) so it executes under the default
// `pnpm test` and in CI without any live dependency.
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { CLAUSES } from './clauses';

const TESTS_ROOT = resolve(__dirname, '..', '..'); // repo/tests

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.test\.ts$/.test(name)) acc.push(p);
  }
  return acc;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Include coverage.test.ts itself: it is the verifying test for FR-001/002/003
// (the traceability mechanism), so its own [SPEC:] tags legitimately count.
const testFiles = walk(TESTS_ROOT);
const allText = testFiles.map((f) => readFileSync(f, 'utf-8')).join('\n');

function isReferenced(id: string): boolean {
  // bare id (word-bounded) OR an explicit bracketed SPEC tag for this id
  const bare = new RegExp(`(?<![\\w-])${escapeRe(id)}(?![\\w-])`);
  const tag = new RegExp(`\\[SPEC:${escapeRe(id)}\\]`);
  return bare.test(allText) || tag.test(allText);
}

describe('[SPEC:FR-002] spec coverage map (clauses <-> tests)', () => {
  const catalogIds = new Set(CLAUSES.map((c) => c.id));

  const covered = CLAUSES.filter((c) => isReferenced(c.id) && !c.waiver);
  const waived = CLAUSES.filter((c) => c.waiver);
  const uncovered = CLAUSES.filter((c) => !isReferenced(c.id) && !c.waiver);

  it('reports the coverage summary', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[spec-coverage] catalog=${CLAUSES.length} covered=${covered.length} ` +
        `waived(pending adjudication)=${waived.length} uncovered=${uncovered.length}\n` +
        waived.map((c) => `  - WAIVED ${c.id}: ${c.waiver}`).join('\n'),
    );
    expect(CLAUSES.length).toBeGreaterThan(0);
  });

  it('[SPEC:FR-002] has no uncovered in-scope clauses (every clause has a test or a waiver)', () => {
    expect(uncovered.map((c) => c.id)).toEqual([]);
  });

  it('[SPEC:FR-001] every [SPEC:<id>] tag references a known catalog clause (no typos)', () => {
    const tagged = new Set<string>();
    // Clause ids are [A-Za-z0-9-]+; this also avoids matching documentation
    // placeholders like "[SPEC:<id>]" that appear in comments/test descriptions.
    for (const m of allText.matchAll(/\[SPEC:([A-Za-z0-9-]+)\]/g)) tagged.add(m[1]);
    const unknown = [...tagged].filter((id) => !catalogIds.has(id));
    expect(unknown).toEqual([]);
  });

  it('[SPEC:FR-003] known spec-vs-implementation deviations are surfaced as waivers, not silent', () => {
    // F4 (frontmatter conflict) and F1/F3 (server quirks) must remain visible.
    const waivedIds = new Set(waived.map((c) => c.id));
    expect(waivedIds.has('CF-12')).toBe(true); // F4
    expect(waivedIds.has('TK-1')).toBe(true); // F1
    expect(waived.length).toBeGreaterThan(0);
  });
});
