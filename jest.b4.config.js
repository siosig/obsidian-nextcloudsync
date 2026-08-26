/** @type {import('jest').Config} */
// Classification "b-4" (live PLAIN WebDAV server, no Nextcloud, no UI). Runs ONLY via `pnpm test:b4`,
// which starts and stops the Apache mod_dav container around it; excluded from the default `pnpm test`
// and from CI. Skips cleanly when the harness has not been started (see support/env.ts).
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/b4-plain-webdav/setup.ts'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/tests/b4-plain-webdav/__mocks__/obsidian.ts',
  },
  testMatch: ['**/tests/b4-plain-webdav/**/*.b4.test.ts'],
  // Scope roots to src + b4 so the "a" suite's support/obsidian.ts is not picked up as a duplicate
  // haste manual mock alongside tests/b4-plain-webdav/__mocks__/.
  roots: ['<rootDir>/src', '<rootDir>/tests/b4-plain-webdav'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  // Live round-trips, even to a local container, are slower than unit tests.
  testTimeout: 60000,
  passWithNoTests: true,
};
