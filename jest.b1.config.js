/** @type {import('jest').Config} */
// Classification "b-1" (live Nextcloud, no UI). Runs ONLY via `pnpm test:b1`;
// excluded from the default `pnpm test` (see jest.config.js) and from CI. These
// tests hit a real Nextcloud server (localhost Docker) using
// credentials from the gitignored .env, and skip cleanly when those are absent.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/b1-nextcloud-headless/setup.ts'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/tests/b1-nextcloud-headless/__mocks__/obsidian.ts',
  },
  testMatch: ['**/tests/b1-nextcloud-headless/**/*.b1.test.ts'],
  // Scope roots to src + b1 so the "a" suite's support/obsidian.ts is not picked
  // up as a duplicate haste manual mock alongside tests/b1-.../__mocks__/.
  roots: ['<rootDir>/src', '<rootDir>/tests/b1-nextcloud-headless'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  // Live network round-trips are far slower than unit tests.
  testTimeout: 60000,
  passWithNoTests: true,
};
