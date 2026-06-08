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
    this.mergeEngine = new MergeEngine({ maxConflictRegions: settings.maxConflictRegions });
  }

  /**
   * Attempt auto-merge if enabled; otherwise embed conflict markers.
   * Returns true if the file was successfully resolved (no markers remaining).
   */
  async resolve(path: string, base: string, local: string, remote: string): Promise<boolean> {
    if (this.settings.autoMergeEnabled) {
      const result = this.mergeEngine.merge(base, local, remote);
      if (result.success && !result.hadConflicts) {
        // Clean auto-merge
        await this.localAdapter.atomicWrite(path, result.mergedContent);
        new Notice(`✅ ${path}: Auto-merge complete (${result.conflictRegions} conflicts resolved)`);
        return true;
      }
      if (result.success && result.hadConflicts) {
        // Partial merge with markers remaining
        const tagged = result.mergedContent.trimEnd() + '\n' + CONFLICT_TAG + '\n';
        await this.localAdapter.atomicWrite(path, tagged);
        new Notice(
          `⚠️ ${path}: ${result.conflictRegions} conflict(s) remain. Check file for markers and remove ${CONFLICT_TAG} when resolved.`,
          10000,
        );
        return false;
      }
    }

    // No auto-merge or merge failed: embed conflict markers via diff3
    const deviceSuffix = this.settings.deviceId.slice(-4);
    const dateStr = new Date().toISOString().slice(0, 10);
    const markerLocal = `<<<<<<< LOCAL (${deviceSuffix}, ${dateStr})`;
    const markerRemote = `>>>>>>> REMOTE (${dateStr})`;

    // Split into lines for a simple section-level marker
    const conflictContent =
      markerLocal + '\n' +
      local.trimEnd() + '\n' +
      '=======\n' +
      remote.trimEnd() + '\n' +
      markerRemote + '\n';

    await this.localAdapter.atomicWrite(path, conflictContent);
    new Notice(
      `⚠️ ${path}: Conflict markers inserted. Search for <<<<<<< to resolve.`,
      10000,
    );
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
