/** @type {import('jest').Config} */
// Spec-conformance suite. Asserts the SPEC's expected behavior; a failure means
// the implementation deviates from the spec (intentional — the suite surfaces
// spec-vs-implementation gaps). Runs ONLY via `pnpm test:conformance`; excluded
// from the default `pnpm test` and from CI (deviations are expected to fail).
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup.ts'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/tests/__mocks__/obsidian.ts',
  },
  testMatch: ['**/tests/conformance/**/*.conformance.test.ts'],
  // Avoid the e2e manual mock clashing in haste-map (it shares the name 'obsidian').
  modulePathIgnorePatterns: ['<rootDir>/tests/e2e/'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  passWithNoTests: true,
};
