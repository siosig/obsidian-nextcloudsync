// b-4 setup: the same Node-side browser primitives the b-1 layer needs.
// Kept as its own file rather than shared so the two live layers stay independently runnable.
import { DOMParser } from '@xmldom/xmldom';

// The WebDAV clients parse multistatus XML with `new DOMParser()`; the jest `node` environment has
// none, so polyfill from @xmldom/xmldom.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

// Source uses window.setTimeout (obsidianmd prefer-window-timers), including the read-only retry path.
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

// Live round-trips, even to a local container, are slower than unit tests.
jest.setTimeout(60000);
