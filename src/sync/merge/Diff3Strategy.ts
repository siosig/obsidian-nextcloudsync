import { MergeResult } from '../../types';
import { IMergeStrategy } from './IMergeStrategy';

interface Diff3Chunk {
  ok?: string[];
  conflict?: { a: string[]; b: string[] };
}

export class Diff3Strategy implements IMergeStrategy {
  merge(base: string, local: string, remote: string): MergeResult {
    try {
      // node-diff3 ships only an `exports` map (no `main`), so an ESM import fails under ts-jest's legacy
      // `moduleResolution: "node"` (TS2307); require() works under both that and esbuild.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- CJS interop for an untyped bundled dependency (esbuild inlines this; never a runtime Node require)
      const { diff3Merge } = require('node-diff3') as {
        diff3Merge: (a: string[], o: string[], b: string[], opts?: Record<string, unknown>) => Diff3Chunk[];
      };
      // Use diff3Merge ({ok}|{conflict} regions), not merge(): its different result shape silently dropped
      // real conflicts (e.g. frontmatter).
      const localLines = local.split('\n');
      const baseLines = base.split('\n');
      const remoteLines = remote.split('\n');

      const result = diff3Merge(localLines, baseLines, remoteLines, { excludeFalseConflicts: true });

      let mergedContent = '';
      let conflictRegions = 0;

      for (const chunk of result) {
        if (chunk.ok) {
          mergedContent += chunk.ok.join('\n');
          if (chunk.ok.length > 0) mergedContent += '\n';
        } else if (chunk.conflict) {
          conflictRegions++;
          mergedContent += '<<<<<<< LOCAL\n';
          mergedContent += chunk.conflict.a.join('\n');
          if (chunk.conflict.a.length > 0) mergedContent += '\n';
          mergedContent += '=======\n';
          mergedContent += chunk.conflict.b.join('\n');
          if (chunk.conflict.b.length > 0) mergedContent += '\n';
          mergedContent += '>>>>>>> REMOTE\n';
        }
      }

      return {
        success: true,
        mergedContent,
        hadConflicts: conflictRegions > 0,
        conflictRegions,
      };
    } catch {
      return { success: false, mergedContent: local, hadConflicts: true, conflictRegions: -1 };
    }
  }
}
