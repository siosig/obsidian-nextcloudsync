// A DOMParser for the a-layer that behaves like the one Obsidian runs (Blink/WebKit).
//
// xmldom THROWS on malformed XML, whereas Blink and WebKit return a document carrying a <parsererror>
// element and zero DAV:response elements. Inputs a test registers as "broken" get that Blink-shaped
// document, so production code sees production-shaped input (issue #51: a truncated listing looked
// like an empty vault in tests).
import { DOMParser as XmldomDOMParser } from '@xmldom/xmldom';

export const PARSERERROR_NS = 'http://www.mozilla.org/newlayout/xml/parsererror.xml';

// Blink: nothing could be parsed; the error element IS the document element.
export const PARSERERROR_ROOT_DOC =
  `<parsererror xmlns="${PARSERERROR_NS}">This page contains the following errors:` +
  `error on line 1 at column 57: Premature end of data in tag multistatus line 1` +
  `</parsererror>`;

// Blink: the root parsed but the body broke off inside it. Includes one real response so a
// naive parser would happily return a partial listing.
export const PARSERERROR_NESTED_DOC =
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">` +
  `<d:response><d:href>/remote.php/dav/files/alice/Vault/a.md</d:href><d:propstat><d:prop><d:getetag>"e"</d:getetag></d:prop></d:propstat></d:response>` +
  `<parsererror xmlns="${PARSERERROR_NS}">error on line 1 at column 512: Premature end of data</parsererror>` +
  `</d:multistatus>`;

export type ParserErrorShape = 'root' | 'nested';

export interface BrowserLikeDOMParserHandle {
  simulateParserError(input: string, shape?: ParserErrorShape): void;
  restore(): void;
}

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
