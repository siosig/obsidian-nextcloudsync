// b-4 setup: the Node-side browser primitives b-1 needs, kept separate so the two live layers run independently.
import { DOMParser } from '@xmldom/xmldom';

// The WebDAV clients parse multistatus XML with `new DOMParser()`, which the jest `node` environment lacks.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

// Source uses window.setTimeout (obsidianmd prefer-window-timers), including the read-only retry path.
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

// Live round-trips are slower than unit tests.
jest.setTimeout(60000);
