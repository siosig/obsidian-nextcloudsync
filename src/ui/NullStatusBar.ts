import { IStatusBar } from './StatusBarItem';

/**
 * No-op status bar for mobile, where Obsidian has no visible status bar and the spec
 * requires that no sync progress is shown. Injected into the sync engine so call sites
 * (setStatus / setProgress / setSyncComplete …) need no platform branching.
 */
export class NullStatusBar implements IStatusBar {
  setStatus(): void { /* no-op */ }
  setProgress(): void { /* no-op */ }
  setConflictCount(): void { /* no-op */ }
  setErrorCount(): void { /* no-op */ }
  setSyncComplete(): void { /* no-op */ }
}
