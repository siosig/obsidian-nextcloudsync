import { App } from 'obsidian';
import { ConflictResolution } from '../types';
import { LocalAdapter } from '../data/LocalAdapter';
import { MergeEngine } from './merge/MergeEngine';

const CONFLICT_TAG = '#conflict';
const CONFLICT_MARKER_RE = /^<<<<<<< /m;

/**
 * Merge/conflict parameters the ConflictResolver needs. After the settings simplification
 * (feature 028) these are no longer user-editable — callers pass the FIXED values. They remain an
 * explicit input (rather than hard-coded inside the resolver) so the class stays pure and every
 * policy/strategy branch is independently unit-testable: internal branching is not user freedom.
 */
export interface MergeConfig {
  autoMergeEnabled: boolean;
  maxConflictRegions: number;
  frontmatterConflictStrategy: 'local-wins' | 'remote-wins' | 'conflict';
  mergeableExtensions: string[];
  conflictFailurePolicy: 'error' | 'local-wins' | 'remote-wins' | 'conflict-markers';
  /** Device id, used for the conflict-marker byline. */
  deviceId: string;
}

export class ConflictResolver {
  private readonly mergeEngine: MergeEngine;

  constructor(
    private readonly app: App,
    private readonly localAdapter: LocalAdapter,
    private readonly config: MergeConfig,
  ) {
    this.mergeEngine = new MergeEngine({
      maxConflictRegions: config.maxConflictRegions,
      frontmatterConflictStrategy: config.frontmatterConflictStrategy,
    });
  }

  /**
   * True when `path`'s extension is configured as mergeable (case-insensitive).
   * Files without an extension, or whose extension is not in `mergeableExtensions`,
   * are never merged.
   */
  isMergeable(path: string): boolean {
    const dot = path.lastIndexOf('.');
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (dot <= slash || dot === path.length - 1) return false; // no extension
    const ext = path.slice(dot + 1).toLowerCase();
    return this.normalizedExtensions().includes(ext);
  }

  /** Normalize the configured extensions (lowercase, strip leading dots/whitespace, drop empties). */
  private normalizedExtensions(): string[] {
    const list = this.config.mergeableExtensions ?? [];
    return list
      .map((e) => e.trim().replace(/^\.+/, '').toLowerCase())
      .filter((e) => e.length > 0);
  }

  /**
   * Decide what to do with a conflicting file. PURE: performs no disk or network I/O.
   * SyncEngine.handleConflict executes the corresponding operations for the returned action.
   *
   * Flow:
   *   1. mergeable && autoMerge → attempt merge; clean result → { write, clean:true }.
   *   2. Otherwise apply conflictFailurePolicy:
   *      'error' → skip; 'local-wins' → prefer-local; 'remote-wins' → prefer-remote;
   *      'conflict-markers' → write markers for mergeable text, else skip (error fallback).
   */
  decide(path: string, base: string, local: string, remote: string): ConflictResolution {
    const mergeable = this.isMergeable(path);
    const policy = this.config.conflictFailurePolicy;

    if (mergeable && this.config.autoMergeEnabled) {
      const result = this.mergeEngine.merge(base, local, remote);
      if (result.success && !result.hadConflicts) {
        return { action: 'write', content: result.mergedContent, clean: true };
      }
      if (policy === 'conflict-markers') {
        if (result.success && result.hadConflicts) {
          // Partial merge: keep the merged body and tag it for the user to finish.
          const tagged = result.mergedContent.trimEnd() + '\n' + CONFLICT_TAG + '\n';
          return { action: 'write', content: tagged, clean: false };
        }
        // Merge refused (e.g. diverging frontmatter): embed full-file conflict markers.
        return { action: 'write', content: this.buildMarkerContent(local, remote), clean: false };
      }
      // Other policies are resolved by the switch below.
    }

    switch (policy) {
      case 'local-wins':
        return { action: 'prefer-local' };
      case 'remote-wins':
        return { action: 'prefer-remote' };
      case 'conflict-markers':
        // Reached when not (mergeable && autoMerge): mergeable-but-autoMerge-off, or non-mergeable.
        if (!mergeable) return { action: 'skip' }; // never embed markers into binary → error fallback
        return { action: 'write', content: this.buildMarkerContent(local, remote), clean: false };
      case 'error':
      default:
        return { action: 'skip' };
    }
  }

  /**
   * Compute the content a resolution would write, WITHOUT touching disk (pure). Mirrors decide()'s
   * decision so callers can compute the resolved content independently of the write path.
   * For skip → keep local (no change); prefer-local → local; prefer-remote → remote.
   * `clean` is true only when the outcome leaves no markers / unresolved state.
   */
  computeResolution(
    path: string, base: string, local: string, remote: string,
  ): { content: string; clean: boolean; conflictRegions: number } {
    const decision = this.decide(path, base, local, remote);
    switch (decision.action) {
      case 'write':
        return { content: decision.content, clean: decision.clean, conflictRegions: decision.clean ? 0 : -1 };
      case 'prefer-local':
        return { content: local, clean: true, conflictRegions: 0 };
      case 'prefer-remote':
        return { content: remote, clean: true, conflictRegions: 0 };
      case 'skip':
      default:
        return { content: local, clean: false, conflictRegions: -1 };
    }
  }

  /** Build full-file conflict-marker content (both versions kept). */
  private buildMarkerContent(local: string, remote: string): string {
    const deviceSuffix = this.config.deviceId.slice(-4);
    const dateStr = new Date().toISOString().slice(0, 10);
    const markerLocal = `<<<<<<< LOCAL (${deviceSuffix}, ${dateStr})`;
    const markerRemote = `>>>>>>> REMOTE (${dateStr})`;
    return (
      markerLocal + '\n' +
      local.trimEnd() + '\n' +
      '=======\n' +
      remote.trimEnd() + '\n' +
      markerRemote + '\n'
    );
  }

  /**
   * Resolve the LOCAL side of a conflict to disk for the `write` action (clean merge or markers).
   * For skip / prefer-local / prefer-remote, the resolution involves network I/O and is performed
   * by SyncEngine.handleConflict; this method does nothing and returns false for those.
   * Returns true only when auto-merge fully resolved with no markers remaining.
   */
  async resolve(path: string, base: string, local: string, remote: string): Promise<boolean> {
    const decision = this.decide(path, base, local, remote);
    if (decision.action === 'write') {
      await this.localAdapter.atomicWrite(path, decision.content);
      return decision.clean;
    }
    return false;
  }

  /** Returns true if the file still contains unresolved conflict markers. */
  hasConflictMarkers(content: string): boolean {
    return CONFLICT_MARKER_RE.test(content);
  }

  /** Remove the #conflict tag from file content (call after user resolves). */
  stripConflictTag(content: string): string {
    return content.replace(new RegExp(`\\n?${CONFLICT_TAG}\\n?`, 'g'), '\n').trim() + '\n';
  }
}
