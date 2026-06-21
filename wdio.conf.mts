// Classification "b-2" (live Nextcloud + real Obsidian UI) runner config.
// wdio-obsidian-service downloads & launches Obsidian with this plugin installed
// and enabled (no Obsidian account needed). Runs ONLY via `pnpm test:b2`; never
// in the default `pnpm test` or CI.
//
// Prerequisites (install first — kept out of the default toolchain):
//   pnpm add -D wdio-obsidian-service wdio-obsidian-reporter @wdio/cli \
//     @wdio/local-runner @wdio/mocha-framework mocha @types/mocha
//   pnpm build   # produce main.js / manifest.json / styles.css at repo root
// Linux/CI also needs a display: run under `xvfb-run -a pnpm test:b2`.
//
// Skips cleanly when NEXTCLOUD_* are absent (the plugin needs them to talk to the
// server); Obsidian itself is provisioned by the service regardless.
import * as path from 'path';
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
      browserVersion: 'latest',
      'wdio:obsidianOptions': {
        installerVersion: 'latest',
        // Install THIS plugin from the repo root build output ("." => main.js +
        // manifest.json); enabled by default.
        plugins: ['.'],
        // Throwaway vault opened as a copy so tests never mutate the template.
        vault: 'tests/b2-nextcloud-ui/support/vault',
      },
      // Electron sandbox off for CI containers.
      'goog:chromeOptions': { args: ['--no-sandbox'] },
    } as WebdriverIO.Capabilities,
  ],

  services: ['obsidian'],
  reporters: ['obsidian'], // shows the Obsidian version instead of Chromium's
  cacheDir: path.resolve('.obsidian-cache'), // downloaded Obsidian versions (gitignored)
  mochaOpts: { ui: 'bdd', timeout: 120000 },
  logLevel: 'warn',

  onPrepare() {
    if (!ui.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[b-2] NEXTCLOUD_* missing (${ui.missing.join(', ')}); sync steps will be skipped.`);
    }
  },
};
