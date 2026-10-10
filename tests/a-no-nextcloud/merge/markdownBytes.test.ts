import { MergeEngine, joinMarkdown } from '../../../src/sync/merge/MergeEngine';
import { MergeContext } from '../../../src/types';

// Same dependency mocks as the main MergeEngine suite, so body merges behave identically here.
jest.mock('reconcile-text', () => ({
  reconcile: (base: string, local: string, remote: string) => {
    const text = local === remote ? local : local + remote;
    return { text, cursors: [] };
  },
}));

jest.mock('node-diff3', () => ({
  diff3Merge: (a: string[], _o: string[], b: string[], _opts: unknown) => {
    const hasConflict = JSON.stringify(a) !== JSON.stringify(b);
    return hasConflict ? [{ conflict: { a, b } }] : [{ ok: a }];
  },
}));

const ctx: MergeContext = { conflictStrategy: 'conflict-markers', localMtime: 2, remoteMtime: 1 };

function resolve(base: string, local: string, remote: string) {
  return new MergeEngine().resolveMarkdown(base, local, remote, {
    frontmatterStrategy: 'merge',
    bodyStrategy: 'merge',
    ctx,
  });
}

const IDENTICAL_INPUTS: Array<[string, string]> = [
  ['closing fence then body', '---\na: 1\n---\nbody\n'],
  ['one blank line kept', '---\na: 1\n---\n\nbody'],
  ['no trailing newline after fence', '---\na: 1\n---'],
  ['fence then newline only', '---\na: 1\n---\n'],
  ['blank line inside the block', '---\na: 1\n\n---\nbody'],
  ['CRLF line endings', '---\r\na: 1\r\n---\r\nbody'],
  ['body only', 'body only\n'],
  ['leading blank lines', '\n\nbody after blank lines'],
  ['empty', ''],
];

describe('Markdown merge keeps bytes', () => {
  describe('identical sides', () => {
    const cases: Array<[string, string, string]> = [];
    for (const [name, input] of IDENTICAL_INPUTS) {
      cases.push([name, 'empty base', '']);
      cases.push([name, 'base equals input', input]);
    }
    it.each(cases)('[SPEC:MBP-1] %s (%s) is returned unchanged', (name, _label, base) => {
      const input = IDENTICAL_INPUTS.find(([n]) => n === name)![1];
      const result = resolve(base, input, input);
      expect(result.mergedContent).toBe(input);
      expect(result.success).toBe(true);
      expect(result.hadConflicts).toBe(false);
    });
  });

  describe('separator after the closing fence', () => {
    const blank = resolve(
      '---\na: 1\n---\n\nB\n',
      '---\na: 1\n---\n\nL\n',
      '---\na: 1\n---\n\nR\n',
    ).mergedContent;
    const tight = resolve(
      '---\na: 1\n---\nB\n',
      '---\na: 1\n---\nL\n',
      '---\na: 1\n---\nR\n',
    ).mergedContent;

    it('[SPEC:MBP-2] keeps the blank line after the fence and adds none before it', () => {
      expect(blank.startsWith('---\na: 1\n---\n\n')).toBe(true);
      expect(blank).not.toContain('\n\n---');
    });

    it('[SPEC:MBP-2] adds no blank line when the input has none', () => {
      expect(tight.startsWith('---\na: 1\n---\n')).toBe(true);
      expect(tight[13]).not.toBe('\n');
      expect(tight).not.toContain('\n\n---');
    });

    it.each([
      ['blank-line output', blank],
      ['tight output', tight],
    ])('[SPEC:MBP-3] %s is a fixed point', (_name, m) => {
      expect(resolve(m, m, m).mergedContent).toBe(m);
      expect(resolve('', m, m).mergedContent).toBe(m);
    });
  });

  describe('frontmatter changed on one side', () => {
    const base = '---\na: 1\n---\n\nbody\n';
    const out = resolve(base, base, '---\na: 2\n---\n\nbody\n').mergedContent;

    it('[SPEC:MBP-4] reserializes the block and keeps the body bytes', () => {
      expect(out.endsWith('---\n\nbody\n')).toBe(true);
      expect(out).toContain('a: 2');
      expect(out).not.toContain('\n\n---');
    });

    it('[SPEC:MBP-3] the output is a fixed point', () => {
      expect(resolve(out, out, out).mergedContent).toBe(out);
      expect(resolve('', out, out).mergedContent).toBe(out);
    });
  });

  describe('joinMarkdown', () => {
    it.each([
      [['', '\n', 'b'], 'b'],
      [['---\na\n---', '', 'b'], '---\na\n---\nb'],
      [['---\na\n---\n', '\n', 'b'], '---\na\n---\n\nb'],
      [['---\na\n---', '', ''], '---\na\n---'],
    ] as Array<[[string, string, string], string]>)('joinMarkdown(%j) -> %j', ([fm, lead, body], expected) => {
      expect(joinMarkdown(fm, lead, body)).toBe(expected);
    });
  });
});
