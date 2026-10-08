import {
  SYNC_RIBBON_ICON,
  SYNC_RIBBON_LABEL,
  registerSyncRibbon,
  SyncRibbonHost,
} from '../../../src/ui/syncRibbon';

// The ribbon button is mobile's one-tap sync entry point (issue #19; mobile renders ribbon icons in the
// hamburger menu). The wiring is extracted into registerSyncRibbon so layer a can check which args reach
// addRibbonIcon and that the callback funnels into the same runSyncNow() as the "Sync now" command.

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
