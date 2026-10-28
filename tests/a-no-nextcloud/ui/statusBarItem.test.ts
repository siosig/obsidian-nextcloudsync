import { StatusBarItem } from '../../../src/ui/StatusBarItem';

// The desktop status bar: a labelled count or a named phase tells the user a long first sync is still working.

function makeEl() {
  const el = { text: '', title: '', setText(t: string) { el.text = t; }, addClass() { /* noop */ }, addEventListener() { /* noop */ } };
  return el;
}

describe('StatusBarItem progress text', () => {
  it('keeps the bare count when no label is given', () => {
    const el = makeEl();
    new StatusBarItem(el as never).setProgress(3, 10);
    expect(el.text).toBe('🔄 3/10');
  });

  it('prefixes the count with the step label', () => {
    const el = makeEl();
    new StatusBarItem(el as never).setProgress(120, 9000, 'Checking server');
    expect(el.text).toBe('🔄 Checking server 120/9000');
  });

  it('shows a phase that has no count yet', () => {
    const el = makeEl();
    new StatusBarItem(el as never).setPhase('Listing server');
    expect(el.text).toBe('🔄 Listing server…');
  });

  it('drops the phase once the sync completes', () => {
    const el = makeEl();
    const bar = new StatusBarItem(el as never);
    bar.setPhase('Syncing folders');
    bar.setSyncComplete(1, 0, 0, 0);
    expect(el.text).toMatch(/^🟢 /);
  });
});
