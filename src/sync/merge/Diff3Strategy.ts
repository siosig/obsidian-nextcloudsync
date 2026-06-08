import { MergeResult } from '../../types';
import { IMergeStrategy } from './IMergeStrategy';

interface Diff3Chunk {
  ok?: string[];
  conflict?: { a: string[]; b: string[] };
}

export class Diff3Strategy implements IMergeStrategy {
  merge(base: string, local: string, remote: string): MergeResult {
    try {
      // node-diff3 is a CommonJS module with no type declarations resolvable under node module
      // resolution; require() keeps it working in both the esbuild bundle and the ts-jest tests.
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS interop for an untyped bundled dependency
      const { merge: diff3Merge } = require('node-diff3') as {
        merge: (a: string[], o: string[], b: string[], opts?: Record<string, unknown>) => { result: Diff3Chunk[]; conflict: boolean };
      };

      const localLines = local.split('\n');
      const baseLines = base.split('\n');
      const remoteLines = remote.split('\n');

      const result = diff3Merge(localLines, baseLines, remoteLines, { excludeFalseConflicts: true });

      let mergedContent = '';
      let conflictRegions = 0;

      for (const chunk of result.result) {
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
