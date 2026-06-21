/** @type {import('jest').Config} */
// Classification "a" (Nextcloud-independent, no UI). This is the DEFAULT `pnpm test`
// and the only suite that runs in CI: pure logic + the spec-coverage meta-test.
// The live suites live under tests/b1-nextcloud-headless/ (pnpm test:b1) and
// tests/b2-nextcloud-ui/ (pnpm test:b2) and are excluded here.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/a-no-nextcloud/support/setup.ts'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/tests/a-no-nextcloud/support/obsidian.ts',
  },
  testMatch: ['**/tests/a-no-nextcloud/**/*.test.ts'],
  // Exclude the live suites from execution and from haste-map scanning
  // (tests/b1-.../__mocks__ shares the name 'obsidian' with tests/a-.../support).
  testPathIgnorePatterns: ['/node_modules/', '/tests/b1-nextcloud-headless/', '/tests/b2-nextcloud-ui/'],
  modulePathIgnorePatterns: ['<rootDir>/tests/b1-nextcloud-headless/', '<rootDir>/tests/b2-nextcloud-ui/'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  passWithNoTests: true,
};
