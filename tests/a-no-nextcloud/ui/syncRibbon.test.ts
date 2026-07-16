import {
  SYNC_RIBBON_ICON,
  SYNC_RIBBON_LABEL,
  registerSyncRibbon,
  SyncRibbonHost,
} from '../../../src/ui/syncRibbon';

// Feature 060 (issue #19): a ribbon button gives mobile users a one-tap sync entry point (Obsidian
// renders ribbon icons inside the hamburger menu on mobile). The wiring is extracted into
// registerSyncRibbon so it can be verified deterministically at layer a without instantiating the
// whole plugin/Obsidian app — the only surface that matters is which args reach addRibbonIcon and
// that its callback funnels into the same runSyncNow() the "Sync now" command uses.

/** Records addRibbonIcon calls and counts runSyncNow invocations. */
function makeFakeHost(): {
  host: SyncRibbonHost;
  calls: { icon: string; title: string; callback: (evt: MouseEvent) => unknown }[];
  syncNowCount: () => number;
} {
  const calls: { icon: string; title: string; callback: (evt: MouseEvent) => unknown }[] = [];
  let syncNow = 0;
  const host: SyncRibbonHost = {
    addRibbonIcon(icon, title, callback) {
      calls.push({ icon, title, callback });
      return {} as HTMLElement;
    },
    runSyncNow() {
      syncNow++;
      return Promise.resolve();
    },
  };
  return { host, calls, syncNowCount: () => syncNow };
}

describe('registerSyncRibbon (feature 060 / issue #19)', () => {
  it('[SPEC:RIB-1] registers exactly one ribbon icon with the refresh-cw icon and "Sync with Nextcloud" label', () => {
    const { host, calls } = makeFakeHost();
    registerSyncRibbon(host);

    expect(calls).toHaveLength(1);
    expect(calls[0].icon).toBe(SYNC_RIBBON_ICON);
    expect(calls[0].icon).toBe('refresh-cw');
    expect(calls[0].title).toBe(SYNC_RIBBON_LABEL);
    expect(calls[0].title).toBe('Sync with Nextcloud');
  });

  it('[SPEC:RIB-2] its callback invokes runSyncNow (shares the "Sync now" command entry point)', () => {
    const { host, calls, syncNowCount } = makeFakeHost();
    registerSyncRibbon(host);

    expect(syncNowCount()).toBe(0); // not called at registration time
    // The wrapper ignores the event arg; jest's node env has no MouseEvent, so pass a dummy.
    calls[0].callback(undefined as unknown as MouseEvent);
    expect(syncNowCount()).toBe(1); // called once per click
  });
});
