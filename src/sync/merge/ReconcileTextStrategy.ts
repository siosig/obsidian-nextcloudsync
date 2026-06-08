import { MergeResult } from '../../types';
import { IMergeStrategy } from './IMergeStrategy';

export class ReconcileTextStrategy implements IMergeStrategy {
  merge(base: string, local: string, remote: string): MergeResult {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { reconcile } = require('reconcile-text') as { reconcile: (b: string, l: string, r: string) => string };
      const merged = reconcile(base, local, remote);
      return { success: true, mergedContent: merged, hadConflicts: false, conflictRegions: 0 };
    } catch {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: -1 };
    }
  }
}
