/** @type {import('jest').Config} */
// E2E (live-server) config. Runs ONLY via `pnpm test:e2e`; excluded from the
// default `pnpm test` (see jest.config.js testPathIgnorePatterns). These tests
// hit a real Nextcloud server using credentials from the gitignored env file,
// and skip cleanly when those are absent.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/e2e/setup.ts'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/tests/e2e/__mocks__/obsidian.ts',
  },
  testMatch: ['**/tests/e2e/**/*.e2e.test.ts'],
  // Scope roots to src + e2e so the unit-test tests/__mocks__/obsidian.ts is not
  // picked up as a duplicate haste manual mock alongside tests/e2e/__mocks__/.
  roots: ['<rootDir>/src', '<rootDir>/tests/e2e'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  // Live network round-trips are far slower than unit tests.
  testTimeout: 60000,
  passWithNoTests: true,
};
