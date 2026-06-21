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

// A skipped test verifies nothing, so a clause traced ONLY to a skipped stub must NOT count as
// covered — it needs a real test or an explicit waiver. This codebase legitimately labels ACTIVE
// assertions with `// CLAUSE-ID:` comments (e.g. VR-2/VR-3 inside an active it()), so we must NOT
// strip all comments. Instead, blank each skipped-test declaration line AND the contiguous comment
// block directly above it (its explanation), leaving comments that label active assertions intact.
const SKIP_DECL = /\b(?:it|test|describe)\.skip\s*\(|\bx(?:it|describe)\s*\(/;
function stripSkippedTraceability(text: string): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (SKIP_DECL.test(lines[i])) {
      lines[i] = ''; // the skip declaration line (its title carries the clause id)
      // Walk up over the skip's own explanation: contiguous comment-only / blank lines.
      for (let j = i - 1; j >= 0 && /^\s*(\/\/.*)?$/.test(lines[j]); j--) lines[j] = '';
    }
  }
  return lines.join('\n');
}

// Include coverage.test.ts itself: it is the verifying test for FR-001/002/003
// (the traceability mechanism), so its own [SPEC:] tags legitimately count.
const testFiles = walk(TESTS_ROOT);
const allText = testFiles.map((f) => stripSkippedTraceability(readFileSync(f, 'utf-8'))).join('\n');

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

  it('[SPEC:FR-002] coverage scan ignores skipped-test traceability but keeps active comment labels', () => {
    // A skipped stub (and its explanation comment) must NOT count as coverage; a comment that labels
    // a real assertion inside an active test must survive. This guards the scanner's blind spot fix.
    const sample = [
      '// SAMPLECLAUSE-SKIP: deferred because the server cannot be driven from a test',
      "it.skip('SAMPLECLAUSE-SKIP deferred e2e', () => undefined);",
      "it('active path', () => {",
      '  // SAMPLECLAUSE-ACTIVE: this comment labels a real assertion',
      '  expect(true).toBe(true);',
      '});',
    ].join('\n');
    const scanned = stripSkippedTraceability(sample);
    expect(scanned).not.toContain('SAMPLECLAUSE-SKIP'); // skip title + its explanation comment removed
    expect(scanned).toContain('SAMPLECLAUSE-ACTIVE'); // active assertion's label preserved
  });

  it('[SPEC:FR-003] known spec-vs-implementation deviations are surfaced as waivers, not silent', () => {
    // F1 (sync-collection 415) and F3 (owner-based lock) must remain visible.
    const waivedIds = new Set(waived.map((c) => c.id));
    // F4 was resolved in 0.7.1 — CF-12 is no longer waived (verified at layer a by
    // diff3Strategy.test.ts). F1/F3 server quirks remain visible.
    expect(waivedIds.has('TK-1')).toBe(true); // F1
    expect(waived.length).toBeGreaterThan(0);
  });
});
