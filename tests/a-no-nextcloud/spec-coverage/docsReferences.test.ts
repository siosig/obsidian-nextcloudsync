// Keeps code comments honest about the public docs: every `docs/spec.md §N` / `docs/plan.md §N`
// reference must hit a real heading, and comments must not point at private paths or carry
// feature-number history markers.
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import ts = require('typescript');

const ROOT = resolve(__dirname, '..', '..', '..');
const SOURCE_DIRS = ['src', 'tests'];

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

function commentsOf(source: string): { line: number; text: string }[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const out: { line: number; text: string }[] = [];
  const braces: ('brace' | 'template')[] = [];
  let prev: ts.SyntaxKind | undefined;
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      out.push({ line: source.slice(0, scanner.getTokenStart()).split('\n').length, text: scanner.getTokenText() });
    } else if (kind !== ts.SyntaxKind.WhitespaceTrivia && kind !== ts.SyntaxKind.NewLineTrivia) {
      if (kind === ts.SyntaxKind.OpenBraceToken) braces.push('brace');
      else if (kind === ts.SyntaxKind.TemplateHead) braces.push('template');
      else if (kind === ts.SyntaxKind.CloseBraceToken) {
        if (braces.pop() === 'template') {
          kind = scanner.reScanTemplateToken(false);
          if (kind === ts.SyntaxKind.TemplateMiddle) braces.push('template');
        }
      } else if (kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) {
        const afterOperand =
          prev === ts.SyntaxKind.Identifier ||
          prev === ts.SyntaxKind.NumericLiteral ||
          prev === ts.SyntaxKind.StringLiteral ||
          prev === ts.SyntaxKind.CloseParenToken ||
          prev === ts.SyntaxKind.CloseBracketToken ||
          prev === ts.SyntaxKind.RegularExpressionLiteral ||
          prev === ts.SyntaxKind.TemplateTail ||
          prev === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
          prev === ts.SyntaxKind.ThisKeyword;
        if (!afterOperand) kind = scanner.reScanSlashToken();
      }
      prev = kind;
    }
    kind = scanner.scan();
  }
  return out;
}

const SECTION = '[0-9]+[a-z]?(?:\\.[0-9]+[a-z]?)*';

function headingsOf(markdown: string): Set<string> {
  const re = new RegExp(`^#{2,4} §(${SECTION})[.\\s]`);
  const found = new Set<string>();
  for (const line of markdown.split('\n')) {
    const m = re.exec(line);
    if (m) found.add(m[1]);
  }
  return found;
}

const files = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)));
const comments = files.flatMap((f) =>
  commentsOf(readFileSync(f, 'utf-8')).map((c) => ({ file: f.slice(ROOT.length + 1), ...c })),
);

describe('[SPEC:DOC-1] comment references to docs/spec.md and docs/plan.md resolve to real sections', () => {
  const headings = {
    spec: headingsOf(readFileSync(join(ROOT, 'docs', 'spec.md'), 'utf-8')),
    plan: headingsOf(readFileSync(join(ROOT, 'docs', 'plan.md'), 'utf-8')),
  };

  it('has no reference to a missing section', () => {
    const ref = new RegExp(`docs/(spec|plan)\\.md §(${SECTION})`, 'g');
    const broken: string[] = [];
    for (const c of comments) {
      for (const m of c.text.matchAll(ref)) {
        const doc = m[1] as 'spec' | 'plan';
        if (!headings[doc].has(m[2])) broken.push(`${c.file}:${c.line} → docs/${doc}.md §${m[2]}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('finds section headings in both documents', () => {
    expect(headings.spec.size).toBeGreaterThan(20);
    expect(headings.plan.size).toBeGreaterThan(15);
  });
});

describe('[SPEC:DOC-2] comments carry no private path or feature-number history marker', () => {
  const forbidden = [
    /specs\/[0-9]{3}-/,
    /specs\/main\//,
    /(^|[^\w-])report\//,
    /\b[Ff]eature [0-9]{3}\b/,
    /\bspec [0-9]{3}\b/,
  ];

  it('has no comment matching a forbidden pattern', () => {
    const hits: string[] = [];
    for (const c of comments) {
      c.text.split('\n').forEach((text, i) => {
        if (forbidden.some((re) => re.test(text))) hits.push(`${c.file}:${c.line + i}: ${text.trim().slice(0, 100)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('extracts only real comments (not text inside strings, templates or regexes)', () => {
    const src = [
      "const a = 'http://x';",
      'const b = `a // b ${c} d`;',
      'const r = /\\/\\//;',
      '// real line',
      '/* real block */',
    ].join('\n');
    expect(commentsOf(src).map((c) => c.text)).toEqual(['// real line', '/* real block */']);
  });
});
