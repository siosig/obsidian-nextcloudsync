import { IStatusBar } from './StatusBarItem';

// Injected on mobile (no status bar, no progress shown) so call sites need no platform branching.
export class NullStatusBar implements IStatusBar {
  setStatus(): void { /* no-op */ }
  setProgress(): void { /* no-op */ }
  setConflictCount(): void { /* no-op */ }
  setErrorCount(): void { /* no-op */ }
  setSyncComplete(): void { /* no-op */ }
}
