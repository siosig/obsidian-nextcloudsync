// [SPEC:RIB-3] [SPEC:SEP-4] How a mobile user actually reaches a ribbon action.
//
// This file exists because the same question was answered wrongly twice.
//
// Feature 060 added a sync ribbon icon for MOBILE users (issue #19) and clause RIB-3 waived the
// mobile claim to a manual check that was never performed. Feature 076 then built on it, a
// screenshot showed no icons, and a probe of this suite measured `.side-dock-ribbon` as
// `display: none` — true, and taken as proof that no ribbon action is reachable on mobile. The
// second ribbon was deleted on that basis.
//
// It was a container measurement generalized into a reachability claim. Obsidian's own docs say what
// actually happens: "The mobile app has no Ribbon. Instead, the ribbon actions will be available
// when you tap Open menu", the last option on the navigation bar. That menu is built on tap, so it
// is invisible to any probe taken while it is closed — which is every probe the earlier version took.
//
// So this test opens the menu and asserts what is inside it. The hidden container is still asserted,
// because it is the reason the menu matters; but it is no longer the end of the measurement.
//
// Two mechanics are deliberate. The tap goes through WebDriver, not `element.click()`: Obsidian's
// mobile navigation bar responds to pointer input, and a synthetic JS click reaches the handler
// without opening anything (observed — the menu stayed shut). JS still CHOOSES the element, by
// marking it with a data attribute, so the selection logic can be as forgiving as it needs to be
// while the tap itself stays real. And every assertion carries the probe with it, so a failure
// reports the DOM it saw instead of a bare `0`.
import { browser, expect } from '@wdio/globals';
import { requireAndroidEnv, requireEnvOrSkip } from '../support/env';

requireAndroidEnv();

// Duplicated from src/ui/ rather than imported: the runner ships only `tests/` to the Android host,
// so `../../../src/...` does not resolve there. Layer a pins the real constants (RIB-1, SEP-3).
const SYNC_RIBBON_LABEL = 'Sync with Nextcloud';
const MIRROR_RIBBON_LABEL = 'Mirror from remote';

/** Attribute used to hand a JS-chosen element to WebDriver for a real tap. */
const TAP_MARK = 'data-b3-open-menu';

interface Box { w: number; h: number; display: string; visibility: string }
interface Candidate { label: string | null; cls: string; x: number; y: number; w: number; h: number }

interface ClosedProbe {
  isMobile: boolean;
  pluginEnabled: boolean;
  ribbonContainers: Box[];
  allRibbonActions: (string | null)[];
  ourCommands: string[];
  /** Every candidate for the navigation bar's "Open menu", so a miss is diagnosable from the report. */
  candidates: Candidate[];
  chosen: Candidate | null;
  viewport: { w: number; h: number };
}

interface OpenProbe {
  tapped: boolean;
  menuCount: number;
  /** Titles of whatever menu Obsidian opened; `.menu-item-title` first, else the item's text. */
  menuItems: string[];
}

const rendered = (boxes: Box[]): boolean =>
  boxes.some((b) => b.w > 0 && b.h > 0 && b.display !== 'none' && b.visibility !== 'hidden');

describe('[SPEC:RIB-3] [SPEC:SEP-4] b-3 — ribbon actions reach mobile through the navigation bar menu', function () {
  let closed: ClosedProbe;
  let open: OpenProbe;

  before(async function () {
    requireEnvOrSkip(this);

    closed = (await browser.executeObsidian(({ app }, mark: string) => {
      const q = (sel: string) => Array.from(document.querySelectorAll(sel));
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { w: Math.round(r.width), h: Math.round(r.height), display: cs.display, visibility: cs.visibility };
      };

      // Anything that could be a navigation-bar button. Deliberately broad: the exact class is
      // Obsidian's to change, and a miss here should show up as a listing to read, not a silence.
      const seen = new Set<Element>();
      const els: HTMLElement[] = [];
      const candidates: { label: string | null; cls: string; x: number; y: number; w: number; h: number }[] = [];
      for (const sel of ['.mobile-navbar-action', '.mobile-navbar > *', '[class*="navbar"] > *']) {
        for (const e of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
          if (seen.has(e)) continue;
          seen.add(e);
          const r = e.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          els.push(e);
          candidates.push({
            label: e.getAttribute('aria-label'),
            cls: e.getAttribute('class') ?? '',
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          });
        }
      }

      // "the last option on the navigation bar" — prefer an explicit label, else the rightmost
      // element sitting on the lowest row of candidates.
      let idx = els.findIndex((e) => /menu/i.test(e.getAttribute('aria-label') ?? ''));
      if (idx < 0 && els.length > 0) {
        const lowest = Math.max(...candidates.map((c) => c.y));
        let best = -1;
        for (let i = 0; i < candidates.length; i++) {
          if (candidates[i].y < lowest - 8) continue; // not on the bottom row
          if (best < 0 || candidates[i].x > candidates[best].x) best = i;
        }
        idx = best;
      }
      if (idx >= 0) els[idx].setAttribute(mark, '1');

      return {
        isMobile: !!(app as any).isMobile,
        pluginEnabled: !!(app as any).plugins.enabledPlugins.has('nextcloud-sync'),
        ribbonContainers: q('.side-dock-ribbon').map(box),
        // addRibbonIcon copies its `title` onto aria-label, so the label is the handle.
        allRibbonActions: q('.side-dock-ribbon-action').map((e) => e.getAttribute('aria-label')),
        ourCommands: Object.keys((app as any).commands.commands).filter((id: string) =>
          id.startsWith('nextcloud-sync:'),
        ),
        candidates,
        chosen: idx >= 0 ? candidates[idx] : null,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      };
    }, TAP_MARK)) as ClosedProbe;

    // A real tap, not element.click(): the navigation bar acts on pointer input.
    let tapped = false;
    if (closed.chosen) {
      const target = await browser.$(`[${TAP_MARK}="1"]`);
      if (await target.isExisting()) {
        await target.click();
        tapped = true;
      }
    }

    // The menu renders on Obsidian's own scheduling; a short settle keeps this from racing a frame.
    await browser.pause(1000);

    const items = (await browser.executeObsidian(() => {
      const titles: string[] = [];
      const menus = Array.from(document.querySelectorAll('.menu'));
      for (const m of menus) {
        for (const item of Array.from(m.querySelectorAll('.menu-item'))) {
          const t = item.querySelector('.menu-item-title');
          const text = (t?.textContent ?? item.textContent ?? '').trim();
          if (text) titles.push(text);
        }
      }
      return { titles, menuCount: menus.length };
    })) as { titles: string[]; menuCount: number };

    open = { tapped, menuCount: items.menuCount, menuItems: items.titles };
  });

  it('registers both ribbon actions, which Obsidian then declines to draw in a ribbon bar', async () => {
    expect(closed.isMobile).toBe(true);
    expect(closed.pluginEnabled).toBe(true);
    // Both actions exist. This is registration, and it is platform-independent.
    expect(closed.allRibbonActions).toContain(SYNC_RIBBON_LABEL);
    expect(closed.allRibbonActions).toContain(MIRROR_RIBBON_LABEL);
    // ...and the ribbon BAR is not drawn: Obsidian's own actions are hidden here too. This is why
    // the menu below is the route, and why measuring only this container was misleading.
    expect(rendered(closed.ribbonContainers)).toBe(false);
  });

  it('lists both of them in the navigation bar menu, so each action is two taps', async () => {
    // Asserted as one object so a failure prints the navigation bar it actually saw. A bare
    // `expect(menuCount).toBeGreaterThan(0)` reports "expected > 0, received 0" and nothing about
    // WHICH element was tapped — which is the only fact that makes the failure actionable.
    expect({
      tapped: open.tapped,
      menuCount: open.menuCount,
      menuItems: open.menuItems,
      tappedElement: closed.chosen,
      navbarCandidates: closed.candidates,
      viewport: closed.viewport,
    }).toEqual(
      expect.objectContaining({
        tapped: true,
        menuItems: expect.arrayContaining([SYNC_RIBBON_LABEL, MIRROR_RIBBON_LABEL]),
      }),
    );
  });

  it('registers the commands that give either action a toolbar pin or a hotkey', async () => {
    expect(closed.ourCommands).toContain('nextcloud-sync:open-sync-status');
    expect(closed.ourCommands).toContain('nextcloud-sync:mirror-from-remote');
    expect(closed.ourCommands).toContain('nextcloud-sync:sync-now');
  });
});
