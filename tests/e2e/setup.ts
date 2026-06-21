// E2E setup: provide the browser primitives NextcloudClient relies on, in Node.
import { DOMParser } from '@xmldom/xmldom';

// NextcloudClient parses WebDAV XML with `new DOMParser()` + getElementsByTagNameNS.
// The jest `node` environment has none, so polyfill from @xmldom/xmldom.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

// Source uses window.setTimeout (obsidianmd prefer-window-timers). Alias window
// onto the Node global so those timer calls resolve (mirrors tests/setup.ts).
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

// Live network round-trips are slow; give every test ample time.
jest.setTimeout(60000);
