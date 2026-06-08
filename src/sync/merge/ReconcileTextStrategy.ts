import { MergeResult } from '../../types';
import { IMergeStrategy } from './IMergeStrategy';

export class ReconcileTextStrategy implements IMergeStrategy {
  merge(base: string, local: string, remote: string): MergeResult {
    try {
      // reconcile() returns a TextWithCursors object ({ text, cursors }), not a string.
      // The merged document is in `.text`; using the object directly corrupts content to "[object Object]".
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { reconcile } = require('reconcile-text') as {
        reconcile: (b: string, l: string, r: string) => string | { text: string };
      };
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
