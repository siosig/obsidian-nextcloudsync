import { reconcile } from 'reconcile-text';
import { MergeResult } from '../../types';
import { IMergeStrategy } from './IMergeStrategy';

export class ReconcileTextStrategy implements IMergeStrategy {
  merge(base: string, local: string, remote: string): MergeResult {
    try {
      // reconcile() returns { text, cursors }, not a string; using the object directly yields "[object Object]".
      const result = reconcile(base, local, remote);
      const merged = typeof result === 'string' ? result : result?.text;
      if (typeof merged !== 'string') {
        return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: -1 };
      }
      return { success: true, mergedContent: merged, hadConflicts: false, conflictRegions: 0 };
    } catch {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: -1 };
    }
  }
}
