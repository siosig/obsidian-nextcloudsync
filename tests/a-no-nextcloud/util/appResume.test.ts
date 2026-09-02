// [SPEC:RSY-1] [SPEC:RSY-2] [SPEC:RSY-3] Sync when the app comes back to the foreground (feature 079,
// GitHub discussion #44).
//
// Mobile has no periodic sync and no watch mode — both are disabled there because the OS suspends
// background timers — so an Obsidian left running in the background never syncs at all. Coming back
// to the app is the one moment when the app is provably alive and the user is provably looking at it,
// which makes it the only trigger that does not depend on background execution being reliable.
//
// The whole risk of this feature is the second half: a trigger that fires on every app switch would
// cost the user data and battery for nothing. So the cooldown is tested as hard as the trigger.
import {
  onAppResume,
  shouldSyncOnResume,
  RESUME_SYNC_COOLDOWN_MS,
} from '../../../src/util/appResume';

describe('[SPEC:RSY-2] shouldSyncOnResume — the cooldown decides, and it is a pure function', () => {
  const COOLDOWN = RESUME_SYNC_COOLDOWN_MS;

  it('syncs when the last sync is older than the cooldown', () => {
    const now = 10_000_000;
    expect(shouldSyncOnResume(now, now - COOLDOWN - 1, COOLDOWN)).toBe(true);
  });

  it('does not sync when the last sync is inside the cooldown', () => {
    const now = 10_000_000;
    expect(shouldSyncOnResume(now, now - COOLDOWN + 1, COOLDOWN)).toBe(false);
  });

  it('syncs at exactly the cooldown boundary', () => {
    // Stated deliberately rather than left to chance: "at least this long has passed" is the
    // condition, so the boundary belongs to the sync side. A test that skipped this would not notice
    // a `>` / `>=` slip in either direction.
    const now = 10_000_000;
    expect(shouldSyncOnResume(now, now - COOLDOWN, COOLDOWN)).toBe(true);
  });

  it('syncs when nothing has ever been synced', () => {
    // A fresh vault has lastSyncTime 0. Treating "never" as "long ago" is what makes the first
    // resume after install do something useful instead of waiting out a cooldown it never started.
    expect(shouldSyncOnResume(10_000_000, 0, COOLDOWN)).toBe(true);
  });

  it('does not sync when the recorded time is in the future', () => {
    // Clock changes and clock skew between devices are real; a state file written by a device whose
    // clock ran ahead must not make every resume sync. Erring towards "do nothing" is the safe side —
    // the periodic and manual paths still work.
    const now = 10_000_000;
    expect(shouldSyncOnResume(now, now + 60_000, COOLDOWN)).toBe(false);
  });
});

describe('[SPEC:RSY-3] onAppResume — subscription and, more importantly, unsubscription', () => {
  /** Minimal stand-ins for the two globals; jest runs this suite under `node`, where neither exists. */
  function installFakeDom() {
    const docListeners = new Map<string, Array<() => void>>();
    const winListeners = new Map<string, Array<() => void>>();
    const add = (m: Map<string, Array<() => void>>) => (type: string, cb: () => void) => {
      const list = m.get(type) ?? [];
      list.push(cb);
      m.set(type, list);
    };
    const remove = (m: Map<string, Array<() => void>>) => (type: string, cb: () => void) => {
      m.set(type, (m.get(type) ?? []).filter((f) => f !== cb));
    };
    const g = globalThis as unknown as Record<string, unknown>;
    const savedDoc = g.document;
    const savedWin = g.window;
    const doc = {
      visibilityState: 'visible',
      addEventListener: add(docListeners),
      removeEventListener: remove(docListeners),
    };
    g.document = doc;
    g.window = { addEventListener: add(winListeners), removeEventListener: remove(winListeners) };
    return {
      doc,
      fire: (m: Map<string, Array<() => void>>, type: string) =>
        [...(m.get(type) ?? [])].forEach((f) => f()),
      docListeners,
      winListeners,
      count: () =>
        [...docListeners.values(), ...winListeners.values()].reduce((n, l) => n + l.length, 0),
      restore: () => { g.document = savedDoc; g.window = savedWin; },
    };
  }

  it('fires on visibilitychange only when the document became visible', () => {
    const dom = installFakeDom();
    try {
      const cb = jest.fn();
      onAppResume(cb);

      dom.doc.visibilityState = 'hidden';
      dom.fire(dom.docListeners, 'visibilitychange');
      expect(cb).not.toHaveBeenCalled(); // going away is not coming back

      dom.doc.visibilityState = 'visible';
      dom.fire(dom.docListeners, 'visibilitychange');
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      dom.restore();
    }
  });

  it('removes every listener it added when unsubscribed', () => {
    // A plugin can be disabled and re-enabled repeatedly. A subscription that outlives its owner
    // leaks a callback holding the old plugin instance, and the leak is silent until something it
    // touches has been torn down.
    const dom = installFakeDom();
    try {
      const unsubscribe = onAppResume(jest.fn());
      expect(dom.count()).toBeGreaterThan(0);
      unsubscribe();
      expect(dom.count()).toBe(0);
    } finally {
      dom.restore();
    }
  });

  it('is inert, and does not throw, where the DOM does not exist', () => {
    // The a-layer suite runs under jest's `node` environment. Guarding here rather than at every
    // call site is what keeps the calling code free of environment checks.
    const g = globalThis as unknown as Record<string, unknown>;
    const savedDoc = g.document;
    const savedWin = g.window;
    delete g.document;
    delete g.window;
    try {
      const cb = jest.fn();
      const unsubscribe = onAppResume(cb);
      expect(() => unsubscribe()).not.toThrow();
      expect(cb).not.toHaveBeenCalled();
    } finally {
      g.document = savedDoc;
      g.window = savedWin;
    }
  });
});
