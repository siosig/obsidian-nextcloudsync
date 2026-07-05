// Feature 047 conflict-option matrix — frontmatterStrategy=merge slice (parallelizable file).
// Body strategy sweep (Auto 5 + Other 4 = 9 combos). Run all five slices in parallel:
//   node node_modules/.bin/jest --config jest.b1.config.js --maxWorkers=5 tests/b1-nextcloud-headless/multidevice/conflictMatrix
import { defineConflictMatrix } from '../support/conflictMatrix';
defineConflictMatrix('merge');
