// [SPEC:RIB-3] [SPEC:SEP-4] How a mobile user actually reaches a ribbon action.
// Obsidian's mobile app has no ribbon: its actions are reached via the navigation bar's "Open menu", which is
// built on tap. So `.side-dock-ribbon` being `display: none` does not make the actions unreachable; this test
// opens the menu and asserts what is inside it.
// The tap goes through WebDriver because a synthetic JS click does not open the menu; JS only chooses the element
// (marked with a data attribute). Every assertion carries the probe so a failure reports the DOM it saw.
import { browser, expect } from '@wdio/globals';
import { requireAndroidEnv, requireEnvOrSkip } from '../support/env';

requireAndroidEnv();

// Duplicated from src/ui/ because the runner ships only `tests/` to the Android host. Layer a pins the real constants (RIB-1, SEP-3).
const SYNC_RIBBON_LABEL = 'Sync with Nextcloud';
const MIRROR_RIBBON_LABEL = 'Mirror from remote';

const TAP_MARK = 'data-b3-open-menu';

interface Box { w: number; h: number; display: string; visibility: string }
interface Candidate { label: string | null; cls: string; x: number; y: number; w: number; h: number }

interface ClosedProbe {
  isMobile: boolean;
  pluginEnabled: boolean;
  ribbonContainers: Box[];
  allRibbonActions: (string | null)[];
  ourCommands: string[];
  // Every candidate for the navigation bar's "Open menu", so a miss is diagnosable from the report.
  candidates: Candidate[];
  chosen: Candidate | null;
  viewport: { w: number; h: number };
}

interface OpenProbe {
  tapped: boolean;
  menuCount: number;
  // Titles of whatever menu Obsidian opened; `.menu-item-title` first, else the item's text.
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

      // Deliberately broad: Obsidian owns the exact class, and a miss should show up as a listing to read.
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

      // Prefer an explicit "menu" label, else the rightmost element on the lowest row of candidates.
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
    expect(closed.allRibbonActions).toContain(SYNC_RIBBON_LABEL);
    expect(closed.allRibbonActions).toContain(MIRROR_RIBBON_LABEL);
    // The ribbon bar itself is not drawn (Obsidian's own actions are hidden too), which is why the menu is the route.
    expect(rendered(closed.ribbonContainers)).toBe(false);
  });

  it('lists both of them in the navigation bar menu, so each action is two taps', async () => {
    // Asserted as one object so a failure prints the navigation bar it saw, not a bare "received 0".
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
