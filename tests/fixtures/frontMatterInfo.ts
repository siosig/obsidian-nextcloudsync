export interface FrontMatterInfoShape {
  exists: boolean;
  frontmatter: string;
  from: number;
  to: number;
  contentStart: number;
}

// Port of Obsidian's own implementation. `frontmatter` keeps its trailing line terminator, and a fence line
// with trailing spaces is not a fence.
export function getFrontMatterInfo(content: string): FrontMatterInfoShape {
  const none: FrontMatterInfoShape = { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
  if (content == null) return none;
  const open = /^---(\r?\n)/.exec(content);
  if (!open) return none;
  const from = open[0].length;
  const close = /---(\r?\n|$)/g;
  close.lastIndex = from;
  let m = close.exec(content);
  while (m && content.charAt(m.index - 1) !== '\n') m = close.exec(content);
  if (!m) return none;
  return { exists: true, frontmatter: content.slice(from, m.index), from, to: m.index, contentStart: close.lastIndex };
}

export const FRONTMATTER_INFO_CORPUS: ReadonlyArray<{ input: string; expected: FrontMatterInfoShape }> = [
  { input: '---\na: 1\n---\nbody\n', expected: { exists: true, frontmatter: 'a: 1\n', from: 4, to: 9, contentStart: 13 } },
  { input: '---\na: 1\n---\n\nbody', expected: { exists: true, frontmatter: 'a: 1\n', from: 4, to: 9, contentStart: 13 } },
  { input: '---\na: 1\n---', expected: { exists: true, frontmatter: 'a: 1\n', from: 4, to: 9, contentStart: 12 } },
  { input: '---\n---\nbody', expected: { exists: true, frontmatter: '', from: 4, to: 4, contentStart: 8 } },
  { input: '---\r\na: 1\r\n---\r\nbody', expected: { exists: true, frontmatter: 'a: 1\r\n', from: 5, to: 11, contentStart: 16 } },
  { input: 'no fm\n---\nx', expected: { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 } },
  { input: '---\na: 1\nno close', expected: { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 } },
  { input: '---\na: 1\n\n---\nbody', expected: { exists: true, frontmatter: 'a: 1\n\n', from: 4, to: 10, contentStart: 14 } },
  { input: '', expected: { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 } },
  { input: '---\na: 1\n--- \nbody\n---\nrest', expected: { exists: true, frontmatter: 'a: 1\n--- \nbody\n', from: 4, to: 19, contentStart: 23 } },
  { input: '---\ntitle: x\n----\n---\nb', expected: { exists: true, frontmatter: 'title: x\n----\n', from: 4, to: 18, contentStart: 22 } },
];
