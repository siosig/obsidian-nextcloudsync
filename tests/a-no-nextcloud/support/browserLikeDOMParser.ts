// A DOMParser for the a-layer that can behave like the one Obsidian actually runs (feature 087).
//
// The a-layer parses XML with @xmldom/xmldom, which THROWS on malformed input. Blink (Electron,
// Android WebView) and WebKit (iOS) do not: they return a document carrying a <parsererror> element
// in the Mozilla error namespace, and simply yield zero DAV:response elements. That difference is
// why the truncated-listing failure behind issue #51 never showed up in tests — here it looked like a
// safe throw, in production it looked like an empty vault.
//
// This wrapper delegates to xmldom for everything, except for inputs a test has registered as
// "broken": those get a Blink-shaped parsererror document instead of a throw, so the production
// code path is exercised with the production-shaped input.
import { DOMParser as XmldomDOMParser } from '@xmldom/xmldom';

export const PARSERERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';

/** What Blink returns when nothing could be parsed: the error element IS the document element. */
export const PARSERERROR_ROOT_DOC =
  `<parsererror xmlns="${PARSERERROR_NS}">This page contains the following errors:` +
  `error on line 1 at column 57: Premature end of data in tag multistatus line 1` +
  `</parsererror>`;

/**
 * What Blink returns when the root parsed but the body broke off inside it: the partial tree, with
 * the error element appended as a child of the root. Includes one real response so a naive parser
 * would happily return a partial listing from it.
 */
export const PARSERERROR_NESTED_DOC =
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">` +
  `<d:response><d:href>/remote.php/dav/files/alice/Vault/a.md</d:href><d:propstat><d:prop><d:getetag>"e"</d:getetag></d:prop></d:propstat></d:response>` +
  `<parsererror xmlns="${PARSERERROR_NS}">error on line 1 at column 512: Premature end of data</parsererror>` +
  `</d:multistatus>`;

export type ParserErrorShape = 'root' | 'nested';

export interface BrowserLikeDOMParserHandle {
  /** From now on, parsing exactly `input` yields a Blink-shaped parsererror document of `shape`. */
  simulateParserError(input: string, shape?: ParserErrorShape): void;
  /** Put back whatever DOMParser was installed before. */
  restore(): void;
}

/** Install the wrapper on `globalThis.DOMParser` and return a handle to drive and undo it. */
export function installBrowserLikeDOMParser(): BrowserLikeDOMParserHandle {
  const g = globalThis as unknown as { DOMParser?: unknown };
  const previous = g.DOMParser;
  const broken = new Map<string, ParserErrorShape>();
  const real = new XmldomDOMParser();

  class BrowserLikeDOMParser {
    parseFromString(source: string, mimeType: string): Document {
      const shape = broken.get(source);
      if (shape === 'root') return real.parseFromString(PARSERERROR_ROOT_DOC, 'text/xml') as unknown as Document;
      if (shape === 'nested') return real.parseFromString(PARSERERROR_NESTED_DOC, 'text/xml') as unknown as Document;
      return real.parseFromString(source, mimeType as 'text/xml') as unknown as Document;
    }
  }
  g.DOMParser = BrowserLikeDOMParser;

  return {
    simulateParserError: (input, shape = 'root') => { broken.set(input, shape); },
    restore: () => { g.DOMParser = previous; },
  };
}
