import { DOMParser } from '@xmldom/xmldom';

// The jest `node` environment has no DOMParser; polyfill it from @xmldom/xmldom for NextcloudClient.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

// Source uses window.setTimeout (prefer-window-timers); alias window to the Node global (as tests/setup.ts does).
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

// Live network round-trips are slow; give every test ample time.
jest.setTimeout(60000);
