import {
  getFrontMatterInfo,
  parseYaml,
  stringifyYaml,
  parseFrontMatterStringArray,
} from './obsidian';

// [SPEC:HFM-14] Verifies the layer-a Obsidian test double itself: merge tests built on it are
// meaningless if it drifts from Obsidian's semantics.
describe('[SPEC:HFM-14] Obsidian test double: frontmatter primitives', () => {
  describe('[SPEC:HFM-14] getFrontMatterInfo', () => {
    it('[SPEC:HFM-14] treats only the leading fence as frontmatter, not a body --- (thematic break)', () => {
      const content = '---\ntags: [a]\n---\n# H\n---\nx';
      const info = getFrontMatterInfo(content);
      expect(info.exists).toBe(true);
      expect(info.frontmatter).toBe('tags: [a]');
      // Offsets bound the inner YAML text exactly.
      expect(content.slice(info.from, info.to)).toBe('tags: [a]');
      // The body (starting at the first heading) still contains the trailing --- break.
      const body = content.slice(info.contentStart);
      expect(body).toBe('# H\n---\nx');
      expect(body).toContain('---');
    });

    it('[SPEC:HFM-14] recognizes CRLF fences', () => {
      const content = '---\r\ntags: [a]\r\n---\r\n\u672c\u6587';
      const info = getFrontMatterInfo(content);
      expect(info.exists).toBe(true);
      expect(info.frontmatter).toBe('tags: [a]');
      expect(content.slice(info.contentStart)).toBe('\u672c\u6587');
    });

    it('[SPEC:HFM-14] reports exists=false when the content does not open with a fence', () => {
      const content = '# Heading\n---\ntags: [a]\n---\n';
      const info = getFrontMatterInfo(content);
      expect(info.exists).toBe(false);
      expect(info.frontmatter).toBe('');
    });

    it('[SPEC:HFM-14] recognizes an empty frontmatter block', () => {
      const info = getFrontMatterInfo('---\n---');
      expect(info.exists).toBe(true);
      expect(info.frontmatter).toBe('');
      expect(info.from).toBe(info.to);
    });

    it('[SPEC:HFM-14] reports exists=false for an unterminated fence', () => {
      const info = getFrontMatterInfo('---\ntags: [a]\nno closing fence');
      expect(info.exists).toBe(false);
    });
  });

  describe('[SPEC:HFM-14] parseYaml / stringifyYaml', () => {
    it('[SPEC:HFM-14] round-trips an object losslessly', () => {
      const obj = { title: 'Note', tags: ['a', 'b'], count: 3, nested: { k: 'v' } };
      const text = stringifyYaml(obj);
      expect(parseYaml(text)).toEqual(obj);
    });

    it('[SPEC:HFM-14] returns null for empty / whitespace-only input', () => {
      expect(parseYaml('')).toBeNull();
      expect(parseYaml('   \n  ')).toBeNull();
    });

    it('[SPEC:HFM-14] stringifyYaml output is pinned (YAML-1.1-ambiguous scalars quoted, no folding)', () => {
      const obj = {
        n: 1,
        yes: 'yes',
        empty: '',
        quote: "it's",
        colon: 'a: b',
        tag: '#tag',
        num: '123',
        bool: 'true',
        date: '2024-01-01',
        list: [],
        map: {},
        tags: ['a', 'b'],
        long: Array(30).fill('word').join(' '),
        multi: 'line1\nline2',
      };
      const text = stringifyYaml(obj);
      expect(text).toBe(
        "'n': 1\n'yes': 'yes'\nempty: ''\nquote: it's\ncolon: 'a: b'\ntag: '#tag'\nnum: '123'\nbool: 'true'\ndate: '2024-01-01'\nlist: []\nmap: {}\ntags:\n  - a\n  - b\nlong: word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word\nmulti: |-\n  line1\n  line2\n",
      );
      expect(parseYaml(text)).toEqual(obj);
    });

    // Doubles must parse as YAML 1.2 core (like Obsidian); only stringify opts into 1.1-safe quoting.
    it('[SPEC:HFM-14] parseYaml keeps YAML-1.1 booleans (yes/on) as strings', () => {
      expect(parseYaml('a: yes\nb: on\nc: 2024-01-01')).toEqual({ a: 'yes', b: 'on', c: '2024-01-01' });
    });

    it('[SPEC:HFM-14] parseYaml throws on malformed YAML', () => {
      expect(() => parseYaml('{ unclosed')).toThrow();
    });
  });

  describe('[SPEC:HFM-14] parseFrontMatterStringArray', () => {
    it('[SPEC:HFM-14] strips a leading # (tag sigil)', () => {
      expect(parseFrontMatterStringArray({ tags: ['#project', 'plain'] }, 'tags')).toEqual([
        'project',
        'plain',
      ]);
    });

    it('[SPEC:HFM-14] normalizes #project and project equivalently', () => {
      expect(parseFrontMatterStringArray({ tags: '#project' }, 'tags')).toEqual(
        parseFrontMatterStringArray({ tags: 'project' }, 'tags'),
      );
    });

    it('[SPEC:HFM-14] wraps a single string into a one-element array', () => {
      expect(parseFrontMatterStringArray({ tag: 'solo' }, 'tag')).toEqual(['solo']);
    });

    it('[SPEC:HFM-14] handles inline and block YAML lists identically via parseYaml', () => {
      const inline = parseYaml('tags: [a, b]');
      const block = parseYaml('tags:\n  - a\n  - b');
      expect(parseFrontMatterStringArray(inline, 'tags')).toEqual(['a', 'b']);
      expect(parseFrontMatterStringArray(block, 'tags')).toEqual(['a', 'b']);
    });

    it('[SPEC:HFM-14] trims surrounding whitespace on entries', () => {
      expect(parseFrontMatterStringArray({ tags: ['  a  ', ' #b '] }, 'tags')).toEqual(['a', 'b']);
    });

    it('[SPEC:HFM-14] supports a RegExp key and returns null for a missing key', () => {
      expect(parseFrontMatterStringArray({ Tags: 'x' }, /^tags$/i)).toEqual(['x']);
      expect(parseFrontMatterStringArray({ tags: 'x' }, 'missing')).toBeNull();
    });

    it('[SPEC:HFM-14] preserves duplicates (callers dedup)', () => {
      expect(parseFrontMatterStringArray({ tags: ['a', 'a', '#a'] }, 'tags')).toEqual([
        'a',
        'a',
        'a',
      ]);
    });
  });
});
