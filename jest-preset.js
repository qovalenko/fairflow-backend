/**
 * Fairflow backend — canonical Jest base preset (QA-CI T-026).
 *
 * SINGLE SOURCE OF TRUTH for every workspace's jest config. Individual
 * workspaces reference it via their package.json `jest` field:
 *
 *   "jest": { "preset": "<rootDir>/../jest-preset.cjs", "rootDir": "src" }
 *
 * ...and add ONLY genuine local overrides (e.g. setupFiles). Do not fork the
 * transform / testRegex / moduleFileExtensions per service — change them here.
 *
 * This intentionally reproduces the config that every workspace already used
 * inline (ts-jest, rootDir=src, .spec.ts, node env) so switching to the preset
 * is behaviour-preserving; the only additions are coverage ignore patterns.
 *
 * Levels (see testing/README.md): a plain `jest` run executes unit + component.
 * Integration suites gate themselves at runtime on TEST_DATABASE_URL /
 * TEST_MONGO_URL (describeIntegration / describeMongoIntegration from
 * @fairflow/testing), so this one preset drives all three levels — CI simply
 * provides the env + `services:` for the integration pass.
 *
 * Allure: testEnvironment allure-jest/node writes results to backend/allure-results
 * (override with ALLURE_RESULTS_DIR). Report: npm run allure:report from backend/.
 */
const path = require('path');

const allureResultsDir =
  process.env.ALLURE_RESULTS_DIR || path.join(__dirname, 'allure-results');

module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coveragePathIgnorePatterns: ['/node_modules/', '/generated/', '\\.spec\\.ts$'],
  coverageDirectory: '../coverage',
  testEnvironment: 'allure-jest/node',
  testEnvironmentOptions: {
    resultsDir: allureResultsDir,
  },
  moduleNameMapper: {
    '^@fairflow/testing/closure$': '<rootDir>/../../testing/dist/closure/index.js',
    '^@fairflow/testing$': '<rootDir>/../../testing/dist/index.js',
    '^@fairflow/shared$': '<rootDir>/../../shared/dist/index.js',
  },
};
