// Spec-traceability helper. Prefix a test name with the spec clause(s) it verifies
// so the coverage meta-test (spec-coverage/coverage.test.ts) can statically map
// clauses -> tests and detect uncovered clauses.
//
// Usage:
//   import { spec } from '../support/specRef';
//   it(`${spec('CF-2', 'FR-008')} same-line conflict skips`, () => { ... });
//
// Produces: "[SPEC:CF-2][SPEC:FR-008] same-line conflict skips"
//
// Bare clause IDs already embedded in legacy test names (e.g. "CN-1", "FR-019")
// are ALSO recognised by the scanner, so retro-tagging is optional.
export function spec(...ids: string[]): string {
  return ids.map((id) => `[SPEC:${id}]`).join('');
}
