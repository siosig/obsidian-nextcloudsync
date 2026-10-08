import { App } from 'obsidian';
import { ConflictResolution, ConflictStrategy, MergeContext, SyncStrategy } from '../types';
import { LocalAdapter } from '../data/LocalAdapter';
import { MergeEngine } from './merge/MergeEngine';
import { isAutoMergeFileType, isMarkdown } from '../util/mergeableExtensions';

const CONFLICT_TAG = '#conflict';
const CONFLICT_MARKER_RE = /^<<<<<<< /m;

// Match only this plugin's own marker lines: a user may legitimately write a bare `<<<<<<< HEAD`, which
// must not trip the re-entrancy guard.
const OPEN_MARKER_RE = /^<<<<<<< LOCAL/m;
const CLOSE_MARKER_RE = /^>>>>>>> REMOTE/m;

// Only a complete marker set is a re-entrancy risk: merging it would re-wrap the markers and duplicate
// the shared block, growing the file geometrically.
export function hasCompleteMarkerSet(content: string): boolean {
  return OPEN_MARKER_RE.test(content) && CLOSE_MARKER_RE.test(content);
}

// A lone half-marker (manual resolution that left one line behind) must not safe-hold: that would never
// push, so the orphan survives on the server and re-conflicts every sync. It goes through the normal merge.
export function hasOrphanMarker(content: string): boolean {
  return OPEN_MARKER_RE.test(content) !== CLOSE_MARKER_RE.test(content);
}

// Explicit input rather than settings read inside the resolver, so the class stays pure and every
// branch is unit-testable.
export interface MergeConfig {
  autoMergeFileTypes: string[];
  autoMergeFileStrategy: SyncStrategy;
  otherFileStrategy: Exclude<SyncStrategy, 'merge'>;
  deviceId: string;
  // Resolves a markdown frontmatter block independently of the body; applies to every `.md`.
  frontmatterStrategy: SyncStrategy;
  // Second-level fallback for a part a primary `merge` could not auto-resolve.
  conflictStrategy: ConflictStrategy;
}

// Passed in by SyncEngine so the resolver stays free of I/O; absent only for merge / local-win / remote-win.
export interface ConflictContext {
  localSize: number;
  remoteSize: number;
  localMtime: number;
  remoteMtime: number;
}

// NUL (the signal git uses) or U+FFFD (invalid UTF-8) marks non-text, so `merge` never writes markers into binary.
export function isLikelyBinary(s: string): boolean {
  return s.includes('\u0000') || s.includes('\uFFFD');
}

export class ConflictResolver {
  private readonly mergeEngine: MergeEngine;

  constructor(
    private readonly app: App,
    private readonly localAdapter: LocalAdapter,
    private readonly config: MergeConfig,
  ) {
    this.mergeEngine = new MergeEngine();
  }

  isAutoMergeFile(path: string): boolean {
    return isAutoMergeFileType(path, this.config.autoMergeFileTypes);
  }

  strategyFor(path: string): SyncStrategy {
    return this.isAutoMergeFile(path) ? this.config.autoMergeFileStrategy : this.config.otherFileStrategy;
  }

  // Pure: SyncEngine.handleConflict performs the I/O for the returned action.
  decide(
    path: string, base: string, local: string, remote: string, ctx?: ConflictContext,
  ): ConflictResolution {
    // Markdown is always special-cased: frontmatter and body are resolved by independent strategies.
    if (isMarkdown(path)) {
      return this.decideMarkdown(path, base, local, remote, ctx);
    }
    switch (this.strategyFor(path)) {
      case 'merge':
        return this.decideMerge(base, local, remote, ctx);
      case 'local-win':
        return { action: 'prefer-local' };
      case 'remote-win':
        return { action: 'prefer-remote' };
      case 'biggest-size':
        return this.decideByComparison(ctx?.localSize, ctx?.remoteSize);
      case 'latest-mtime':
        return this.decideByComparison(ctx?.localMtime, ctx?.remoteMtime);
    }
  }

  private mergeCtx(ctx?: ConflictContext): MergeContext {
    return {
      localMtime: ctx?.localMtime ?? 0,
      remoteMtime: ctx?.remoteMtime ?? 0,
      conflictStrategy: this.config.conflictStrategy,
    };
  }

  private decideMerge(base: string, local: string, remote: string, ctx?: ConflictContext): ConflictResolution {
    // Non-text content cannot carry markers.
    if (isLikelyBinary(local) || isLikelyBinary(remote)) {
      return this.binaryConflict(ctx);
    }
    // Merging an existing complete marker set would re-wrap it and duplicate shared blocks, so hold until
    // the user removes the markers; the normal merge resumes once the inputs are clean.
    if (hasCompleteMarkerSet(local) || hasCompleteMarkerSet(remote)) {
      return { action: 'safe-hold' };
    }
    const result = this.mergeEngine.merge(base, local, remote, this.mergeCtx(ctx));
    // Nested/stacked markers are a corruption fingerprint: never write or push them.
    if (result.hold) {
      return { action: 'safe-hold' };
    }
    // The engine already applied conflictStrategy per region; markers remain only under conflict-markers.
    return { action: 'write', content: result.mergedContent, clean: result.success && !result.hadConflicts };
  }

  // Markers would corrupt binary, so conflict-markers safe-holds; other strategies pick a whole side.
  private binaryConflict(ctx?: ConflictContext): ConflictResolution {
    switch (this.config.conflictStrategy) {
      case 'local-win':
        return { action: 'prefer-local' };
      case 'remote-win':
        return { action: 'prefer-remote' };
      case 'biggest-size':
        return this.decideByComparison(ctx?.localSize, ctx?.remoteSize);
      case 'latest-mtime':
        return this.decideByComparison(ctx?.localMtime, ctx?.remoteMtime);
      case 'conflict-markers':
      default:
        return { action: 'safe-hold' };
    }
  }

  // A whole-side pick still yields a `write` of the composed file, because the frontmatter and body
  // halves may resolve differently. Body markers stay in the body, never in the `---` block.
  private decideMarkdown(path: string, base: string, local: string, remote: string, ctx?: ConflictContext): ConflictResolution {
    if ((isLikelyBinary(local) || isLikelyBinary(remote)) && this.config.autoMergeFileStrategy === 'merge') {
      return this.binaryConflict(ctx);
    }
    if (hasCompleteMarkerSet(local) || hasCompleteMarkerSet(remote)) {
      return { action: 'safe-hold' };
    }
    // The body always uses autoMergeFileStrategy, even when `md` is not in autoMergeFileTypes.
    const result = this.mergeEngine.resolveMarkdown(base, local, remote, {
      frontmatterStrategy: this.config.frontmatterStrategy,
      bodyStrategy: this.config.autoMergeFileStrategy,
      ctx: this.mergeCtx(ctx),
    });
    if (result.hold) {
      return { action: 'safe-hold' };
    }
    return { action: 'write', content: result.mergedContent, clean: result.success && !result.hadConflicts };
  }

  // Equal metrics are a tie (no-op); missing context safe-holds.
  private decideByComparison(localMetric?: number, remoteMetric?: number): ConflictResolution {
    if (localMetric === undefined || remoteMetric === undefined) return { action: 'safe-hold' };
    if (localMetric === remoteMetric) return { action: 'no-op' };
    return localMetric > remoteMetric ? { action: 'prefer-local' } : { action: 'prefer-remote' };
  }

  // Pure counterpart of decide(): `clean` is true only when no markers or unresolved state remain.
  computeResolution(
    path: string, base: string, local: string, remote: string, ctx?: ConflictContext,
  ): { content: string; clean: boolean; conflictRegions: number } {
    const decision = this.decide(path, base, local, remote, ctx);
    switch (decision.action) {
      case 'write':
        return { content: decision.content, clean: decision.clean, conflictRegions: decision.clean ? 0 : -1 };
      case 'prefer-local':
        return { content: local, clean: true, conflictRegions: 0 };
      case 'prefer-remote':
        return { content: remote, clean: true, conflictRegions: 0 };
      case 'no-op':
        return { content: local, clean: true, conflictRegions: 0 };
      case 'safe-hold':
      default:
        return { content: local, clean: false, conflictRegions: -1 };
    }
  }

  // Only the `write` action touches disk here; the others need network I/O in SyncEngine.handleConflict.
  async resolve(
    path: string, base: string, local: string, remote: string, ctx?: ConflictContext,
  ): Promise<boolean> {
    const decision = this.decide(path, base, local, remote, ctx);
    if (decision.action === 'write') {
      await this.localAdapter.atomicWrite(path, decision.content);
      return decision.clean;
    }
    return false;
  }

  hasConflictMarkers(content: string): boolean {
    return CONFLICT_MARKER_RE.test(content);
  }

  stripConflictTag(content: string): string {
    return content.replace(new RegExp(`\\n?${CONFLICT_TAG}\\n?`, 'g'), '\n').trim() + '\n';
  }
}
