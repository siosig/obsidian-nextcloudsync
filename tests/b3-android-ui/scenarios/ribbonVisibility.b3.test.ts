// [SPEC:SEP-3] Obsidian mobile does not render the ribbon, so commands are the mobile route.
//
// Feature 060 added a sync ribbon icon for MOBILE users (issue #19), on the belief that Obsidian
// renders ribbon icons inside the hamburger menu there. Clause RIB-3 waived that belief to a manual
// check which was never performed, and feature 076 then built a second ribbon icon on top of it.
// A screenshot from a real phone showed neither icon.
//
// A screenshot cannot separate "missing from the DOM" from "present but hidden by CSS", but
// executeObsidian runs inside Obsidian's own renderer, so the DOM can simply be asked. It answered:
// the actions ARE registered, and `.side-dock-ribbon` is display:none — Obsidian's own seven ribbon
// actions are hidden along with ours. The ribbon is a desktop affordance, full stop.
//
// This file exists to keep that answer honest. If Obsidian ever starts rendering the ribbon on
// mobile, the first assertion fails and the ribbon becomes worth revisiting as a mobile entry point.
// Until then, the second assertion is the one that matters: the commands must be there, because they
// are the only way a mobile user reaches Mirror from remote in two taps.
import { browser, expect } from '@wdio/globals';
import { requireAndroidEnv, requireEnvOrSkip } from '../support/env';

requireAndroidEnv();

// Duplicated from src/ui/syncRibbon.ts rather than imported: the runner ships only `tests/` to the
// Android host, so `../../../src/...` does not resolve there. Layer a pins the real constant (RIB-1).
const SYNC_RIBBON_LABEL = 'Sync with Nextcloud';

interface Box { w: number; h: number; display: string; visibility: string }
interface Probe {
  isMobile: boolean;
  pluginEnabled: boolean;
  ribbonContainers: Box[];
  syncRibbon: Box[];
  allRibbonActions: (string | null)[];
  ourCommands: string[];
}

const rendered = (boxes: Box[]): boolean =>
  boxes.some((b) => b.w > 0 && b.h > 0 && b.display !== 'none' && b.visibility !== 'hidden');

describe('[SPEC:SEP-3] b-3 — the ribbon is invisible on mobile; commands are the route', function () {
  let probe: Probe;

  before(async function () {
    requireEnvOrSkip(this);
    probe = (await browser.executeObsidian(({ app }, syncLabel: string) => {
      const q = (sel: string) => Array.from(document.querySelectorAll(sel));
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          display: cs.display, visibility: cs.visibility,
        };
      };
      return {
        isMobile: !!(app as any).isMobile,
        pluginEnabled: !!(app as any).plugins.enabledPlugins.has('nextcloud-sync'),
        ribbonContainers: q('.side-dock-ribbon').map(box),
        // addRibbonIcon copies its `title` onto aria-label, so the label is the handle.
        syncRibbon: q(`[aria-label="${syncLabel.replace(/"/g, '\\"')}"]`).map(box),
        allRibbonActions: q('.side-dock-ribbon-action').map((e) => e.getAttribute('aria-label')),
        ourCommands: Object.keys((app as any).commands.commands).filter((id: string) =>
          id.startsWith('nextcloud-sync:'),
        ),
      };
    }, SYNC_RIBBON_LABEL)) as Probe;
    console.log('[b3-ribbon-probe] ' + JSON.stringify(probe, null, 2));
  });

  it('registers ribbon actions that Obsidian then hides — the container is display:none', async () => {
    expect(probe.isMobile).toBe(true);
    expect(probe.pluginEnabled).toBe(true);
    // The action exists: this is a platform decision, not a registration failure on our side.
    expect(probe.allRibbonActions).toContain(SYNC_RIBBON_LABEL);
    expect(probe.syncRibbon.length).toBeGreaterThan(0);
    // ...and nothing about it reaches the screen, because its container is hidden.
    expect(rendered(probe.ribbonContainers)).toBe(false);
    expect(rendered(probe.syncRibbon)).toBe(false);
  });

  it('registers the commands that a mobile user actually reaches the dialog and the mirror through', async () => {
    expect(probe.ourCommands).toContain('nextcloud-sync:open-sync-status');
    expect(probe.ourCommands).toContain('nextcloud-sync:mirror-from-remote');
    expect(probe.ourCommands).toContain('nextcloud-sync:sync-now');
  });
});
