import { Notice } from 'obsidian';
import { NoticeStatusBar } from '../../../src/ui/NoticeStatusBar';

// Access the mock's instance registry (see tests/__mocks__/obsidian.ts).
const NoticeMock = Notice as unknown as { instances: Array<{ message: string; timeout?: number; hidden: boolean }> };

function lastNotice() {
  return NoticeMock.instances[NoticeMock.instances.length - 1];
}

describe('NoticeStatusBar', () => {
  let bar: NoticeStatusBar;

  beforeEach(() => {
    jest.useFakeTimers();
    NoticeMock.instances = [];
    bar = new NoticeStatusBar();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // ── US1: startup feedback / single toast ─────────────────────────────────
  it('C2: setStatus("syncing") with no progress creates exactly one toast "🔄 Syncing…"', () => {
    bar.setStatus('syncing');
    expect(NoticeMock.instances).toHaveLength(1);
    expect(lastNotice().message).toBe('🔄 Syncing…');
    expect(lastNotice().timeout).toBe(0); // persistent
  });

  it('C1: a full syncing→complete sequence constructs exactly one Notice', () => {
    bar.setStatus('syncing');
    bar.setProgress(1, 5);
    bar.setProgress(3, 5);
    bar.setSyncComplete(3, 5, 0, 0);
    expect(NoticeMock.instances).toHaveLength(1);
  });

  it('completion with changes renders "🟢 Synced ↑3 ↓5"', () => {
    bar.setStatus('syncing');
    bar.setSyncComplete(3, 5, 0, 0);
    expect(lastNotice().message).toBe('🟢 Synced ↑3 ↓5');
  });

  it('completion with no changes renders "🟢 Up to date"', () => {
    bar.setStatus('syncing');
    bar.setSyncComplete(0, 0, 0, 0);
    expect(lastNotice().message).toBe('🟢 Up to date');
  });

  it('success auto-dismisses after 4s', () => {
    bar.setStatus('syncing');
    bar.setSyncComplete(3, 5, 0, 0);
    expect(lastNotice().hidden).toBe(false);
    jest.advanceTimersByTime(3999);
    expect(lastNotice().hidden).toBe(false);
    jest.advanceTimersByTime(1);
    expect(lastNotice().hidden).toBe(true);
  });

  // ── US2: live progress ───────────────────────────────────────────────────
  it('C1: setProgress updates the same toast to "🔄 12/150" without a new Notice', () => {
    bar.setStatus('syncing');
    bar.setProgress(12, 150);
    expect(NoticeMock.instances).toHaveLength(1);
    expect(lastNotice().message).toBe('🔄 12/150');
  });

  it('setProgress before any setStatus still creates exactly one toast', () => {
    bar.setProgress(2, 4);
    expect(NoticeMock.instances).toHaveLength(1);
    expect(lastNotice().message).toBe('🔄 2/4');
  });

  // ── US3: conflict & error outcomes ───────────────────────────────────────
  it('C3: errors render "🔴 2 errors — ↑1 ↓0" and dismiss after 10s', () => {
    bar.setStatus('syncing');
    bar.setSyncComplete(1, 0, 0, 2);
    expect(lastNotice().message).toBe('🔴 2 errors — ↑1 ↓0');
    jest.advanceTimersByTime(9999);
    expect(lastNotice().hidden).toBe(false);
    jest.advanceTimersByTime(1);
    expect(lastNotice().hidden).toBe(true);
  });

  it('conflicts render "🟡 1 conflict — ↑0 ↓0" and dismiss after 10s', () => {
    bar.setStatus('syncing');
    bar.setSyncComplete(0, 0, 1, 0);
    expect(lastNotice().message).toBe('🟡 1 conflict — ↑0 ↓0');
    jest.advanceTimersByTime(10000);
    expect(lastNotice().hidden).toBe(true);
  });

  it('errors take priority over conflicts', () => {
    bar.setStatus('syncing');
    bar.setSyncComplete(0, 0, 3, 2);
    expect(lastNotice().message).toBe('🔴 2 errors — ↑0 ↓0');
  });

  it('pluralizes counts (1 vs many)', () => {
    bar.setStatus('syncing');
    bar.setSyncComplete(0, 0, 0, 1);
    expect(lastNotice().message).toBe('🔴 1 error — ↑0 ↓0');
  });

  it('C5: a new sync while a completion toast is visible reuses the toast (no new instance)', () => {
    bar.setStatus('syncing');
    bar.setSyncComplete(1, 1, 0, 0); // arms 4s dismiss
    bar.setStatus('syncing'); // new run before dismissal
    expect(NoticeMock.instances).toHaveLength(1);
    // pending dismiss timer must be cleared: advancing past 4s must NOT hide the reused toast
    jest.advanceTimersByTime(5000);
    expect(lastNotice().hidden).toBe(false);
  });

  it('C4: after dismissal a subsequent sync constructs a fresh toast', () => {
    bar.setStatus('syncing');
    bar.setSyncComplete(1, 0, 0, 0);
    jest.advanceTimersByTime(4000);
    expect(lastNotice().hidden).toBe(true);
    bar.setStatus('syncing');
    expect(NoticeMock.instances).toHaveLength(2);
    expect(lastNotice().hidden).toBe(false);
  });

  it('setConflictCount/setErrorCount feed the completion render', () => {
    bar.setStatus('syncing');
    bar.setErrorCount(2);
    bar.setConflictCount(1);
    bar.setSyncComplete(0, 0, 1, 2); // engine passes final counts too
    expect(lastNotice().message).toBe('🔴 2 errors — ↑0 ↓0');
  });
});
