// Classification "b-2" (live Nextcloud + real Obsidian UI) runner config.
// Uses wdio-obsidian-service to launch a real Obsidian with this plugin installed.
// Runs ONLY via `pnpm test:b2`; never in the default `pnpm test` or CI.
//
// Prerequisites (install before first run — kept out of the default toolchain):
//   pnpm add -D @wdio/cli @wdio/local-runner @wdio/mocha-framework wdio-obsidian-service
// Confirm the exact wdio-obsidian-service options against its README at install
// time (see specs/019-test-suite-reorg/research.md D4); the shape below is the
// documented baseline (auto-handles trust prompt / chromedriver / Obsidian DL).
//
// Skips cleanly when OBSIDIAN_*/NEXTCLOUD_* are absent (onPrepare guard).
import { requireUiEnv } from './tests/b2-nextcloud-ui/support/env';

const ui = requireUiEnv();

export const config: WebdriverIO.Config = {
  runner: 'local',
  framework: 'mocha',
  specs: ['./tests/b2-nextcloud-ui/scenarios/**/*.b2.test.ts'],
  maxInstances: 1, // serial: avoid server overload / cross-test interference (FR-023)
  capabilities: [
    {
      browserName: 'obsidian',
      // wdio-obsidian-service provisions the Obsidian binary and a throwaway vault
      // with this plugin enabled. Vault template lives under tests/b2-nextcloud-ui/support.
      'wdio:obsidianOptions': {
        plugins: ['.'], // load the built plugin from the repo root (main.js/manifest.json)
      },
    } as WebdriverIO.Capabilities,
  ],
  services: ['obsidian'],
  mochaOpts: { ui: 'bdd', timeout: 120000 },
  // Surface skip reason and avoid launching a browser when creds are missing.
  onPrepare() {
    if (!ui.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[b-2] skipping UI suite: missing env ${ui.missing.join(', ')}`);
      // No specs will meaningfully run; the guard in each spec also short-circuits.
    }
  },
};
