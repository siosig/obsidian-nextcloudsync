import { IStatusBar } from './StatusBarItem';

// A status surface that shows nothing: used for a silent sync (startup sync with notifications disabled),
// so the sync still runs but produces no toast. Stateless, so one instance is reusable.
export class NullStatusBar implements IStatusBar {
  setStatus(): void { /* no-op */ }
  setProgress(): void { /* no-op */ }
  setConflictCount(): void { /* no-op */ }
  setErrorCount(): void { /* no-op */ }
  setSyncComplete(): void { /* no-op */ }
}
