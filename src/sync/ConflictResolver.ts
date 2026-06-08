import { App, Notice } from 'obsidian';
import { DavSyncSettings } from '../types';
import { LocalAdapter } from '../data/LocalAdapter';
import { MergeEngine } from './merge/MergeEngine';

const CONFLICT_TAG = '#conflict';
const CONFLICT_MARKER_RE = /^<<<<<<< /m;

export class ConflictResolver {
  private readonly mergeEngine: MergeEngine;

  constructor(
    private readonly app: App,
    private readonly localAdapter: LocalAdapter,
    private readonly settings: DavSyncSettings,
  ) {
    this.mergeEngine = new MergeEngine({
      maxConflictRegions: settings.maxConflictRegions,
      frontmatterConflictStrategy: settings.frontmatterConflictStrategy,
    });
  }

  /**
   * Compute the content a resolution would write, WITHOUT touching disk (pure).
   * Mirrors resolve()'s decision exactly so callers (e.g. the debug merge preview) see
   * the same result a real sync would produce.
   * `clean` is true only when auto-merge fully resolved with no markers remaining.
   */
  computeResolution(base: string, local: string, remote: string): { content: string; clean: boolean; conflictRegions: number } {
    if (this.settings.autoMergeEnabled) {
      const result = this.mergeEngine.merge(base, local, remote);
      if (result.success && !result.hadConflicts) {
        return { content: result.mergedContent, clean: true, conflictRegions: result.conflictRegions };
      }
      if (result.success && result.hadConflicts) {
        // Partial merge with markers remaining; tag for the user to finish.
        const tagged = result.mergedContent.trimEnd() + '\n' + CONFLICT_TAG + '\n';
        return { content: tagged, clean: false, conflictRegions: result.conflictRegions };
      }
    }

    // No auto-merge or merge refused (e.g. diverging frontmatter): embed section-level conflict markers.
    const deviceSuffix = this.settings.deviceId.slice(-4);
    const dateStr = new Date().toISOString().slice(0, 10);
    const markerLocal = `<<<<<<< LOCAL (${deviceSuffix}, ${dateStr})`;
    const markerRemote = `>>>>>>> REMOTE (${dateStr})`;
    const conflictContent =
      markerLocal + '\n' +
      local.trimEnd() + '\n' +
      '=======\n' +
      remote.trimEnd() + '\n' +
      markerRemote + '\n';
    return { content: conflictContent, clean: false, conflictRegions: -1 };
  }

  /**
   * Attempt auto-merge if enabled; otherwise embed conflict markers.
   * Returns true if the file was successfully resolved (no markers remaining).
   */
  async resolve(path: string, base: string, local: string, remote: string): Promise<boolean> {
    const { content, clean, conflictRegions } = this.computeResolution(base, local, remote);
    await this.localAdapter.atomicWrite(path, content);
    if (clean) {
      new Notice(`✅ ${path}: Auto-merge complete (${conflictRegions} conflicts resolved)`);
    } else if (conflictRegions >= 0) {
      new Notice(
        `⚠️ ${path}: ${conflictRegions} conflict(s) remain. Check file for markers and remove ${CONFLICT_TAG} when resolved.`,
        10000,
      );
    } else {
      new Notice(`⚠️ ${path}: Conflict markers inserted. Search for <<<<<<< to resolve.`, 10000);
    }
    return clean;
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
