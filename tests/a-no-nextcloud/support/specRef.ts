// Prefix a test name with the spec clause(s) it verifies so spec-coverage/coverage.test.ts can map
// clauses to tests. `spec('CF-2', 'FR-008')` yields "[SPEC:CF-2][SPEC:FR-008]".
export function spec(...ids: string[]): string {
  return ids.map((id) => `[SPEC:${id}]`).join('');
}
