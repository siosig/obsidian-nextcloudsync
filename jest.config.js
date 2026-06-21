/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup.ts'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/tests/__mocks__/obsidian.ts',
  },
  testMatch: ['**/tests/**/*.test.ts'],
  // The live E2E suite lives under tests/e2e/ and runs only via `pnpm test:e2e`
  // (jest.e2e.config.js). Exclude it from the default run and from CI.
  // testPathIgnorePatterns stops execution; modulePathIgnorePatterns stops haste-map
  // from scanning tests/e2e/__mocks__ (which would clash with tests/__mocks__).
  testPathIgnorePatterns: ['/node_modules/', '/tests/e2e/', '/tests/conformance/'],
  modulePathIgnorePatterns: ['<rootDir>/tests/e2e/', '<rootDir>/tests/conformance/'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  passWithNoTests: true,
};
