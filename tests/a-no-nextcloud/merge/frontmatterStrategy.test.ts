// Feature 047: frontmatter is resolved by `frontmatterStrategy`, INDEPENDENTLY of the body strategy.
// Integration-style: the REAL FrontmatterMergeStrategy + reconcile/diff3 run through ConflictResolver
// (no merge mocks), so this validates true end-to-end split-resolution behaviour.
import { ConflictResolver, MergeConfig, ConflictContext } from '../../../src/sync/ConflictResolver';
import { SyncStrategy } from '../../../src/types';
import type { App } from 'obsidian';
import type { LocalAdapter } from '../../../src/data/LocalAdapter';

function makeConfig(frontmatterStrategy: SyncStrategy, bodyStrategy: SyncStrategy): MergeConfig {
  // `md` is an Auto Merge File type, so strategyFor('*.md') === bodyStrategy (autoMergeFileStrategy).
  const otherFileStrategy = (bodyStrategy === 'merge' ? 'latest-mtime' : bodyStrategy) as Exclude<SyncStrategy, 'merge'>;
  return { autoMergeFileTypes: ['md'], autoMergeFileStrategy: bodyStrategy, otherFileStrategy, deviceId: 'dev-abcd', frontmatterStrategy };
}

function resolver(frontmatterStrategy: SyncStrategy, bodyStrategy: SyncStrategy): ConflictResolver {
  return new ConflictResolver({} as App, {} as unknown as LocalAdapter, makeConfig(frontmatterStrategy, bodyStrategy));
}

const ctx = (over: Partial<ConflictContext> = {}): ConflictContext => ({
  localSize: 100, remoteSize: 100, localMtime: 1000, remoteMtime: 1000, ...over,
});

const withFm = (tags: string[], body: string): string =>
  `---\ntags:\n${tags.map((t) => `  - ${t}`).join('\n')}\n---\n${body}`;

// tags added on each side; body differs. base has the shared tag only.
const BASE = withFm(['work'], 'BaseBody');
const LOCAL = withFm(['work', 'ltag'], 'LocalBody');
const REMOTE = withFm(['work', 'rtag'], 'RemoteBody');

function asWrite(r: ReturnType<ConflictResolver['decide']>): { content: string; clean: boolean } {
  if (r.action !== 'write') throw new Error(`expected write, got ${r.action}`);
  return { content: r.content, clean: r.clean };
}
const writeContent = (r: ReturnType<ConflictResolver['decide']>): string => asWrite(r).content;

describe('feature 047 — frontmatter resolved independently of body (US1: merge)', () => {
  it('[SC-001] body=latest-mtime keeps the newer body, but frontmatterStrategy=merge still unions tags', () => {
    const w = asWrite(resolver('merge', 'latest-mtime').decide('note.md', BASE, LOCAL, REMOTE, ctx({ localMtime: 2000, remoteMtime: 1000 })));
    const c = w.content;
    expect(w.clean).toBe(true);            // fm merge is clean; body pick is clean
    expect(c).toContain('LocalBody');      // local body is newer
    expect(c).not.toContain('RemoteBody');
    expect(c).toContain('ltag');           // both tag additions survive
    expect(c).toContain('rtag');
    expect(c).not.toMatch(/^<<<<<<< /m);   // no markers anywhere
  });

  it('[US1] body=remote-win keeps the remote body, but tags still union', () => {
    const r = resolver('merge', 'remote-win').decide('note.md', BASE, LOCAL, REMOTE, ctx());
    const c = writeContent(r);
    expect(c).toContain('RemoteBody');
    expect(c).not.toContain('LocalBody');
    expect(c).toContain('ltag');
    expect(c).toContain('rtag');
  });

  it('[FR-008/SC-003] a body-only conflict writes markers in the BODY, never inside the --- block', () => {
    // Identical frontmatter on both sides, body genuinely conflicting against a real base (both sides
    // changed the same line differently) → diff3 detects it → body markers.
    const base = withFm(['work'], 'Same line\nBASE edit');
    const local = withFm(['work'], 'Same line\nLOCAL edit');
    const remote = withFm(['work'], 'Same line\nREMOTE edit');
    const w = asWrite(resolver('merge', 'merge').decide('note.md', base, local, remote, ctx()));
    const c = w.content;
    expect(w.clean).toBe(false);                       // body conflict → not clean
    const fmBlock = c.slice(0, c.indexOf('---', 3) + 3);
    expect(fmBlock).not.toMatch(/<<<<<<< |=======|>>>>>>> /); // frontmatter block is marker-free
    expect(c).toMatch(/^<<<<<<< LOCAL/m);              // markers live in the body
  });
});

describe('feature 047 — frontmatter whole-side strategies (US2)', () => {
  it('[FR-007] local-win adopts the whole local frontmatter block (no union)', () => {
    const c = writeContent(resolver('local-win', 'merge').decide('note.md', BASE, LOCAL, REMOTE, ctx()));
    expect(c).toContain('ltag');
    expect(c).not.toContain('rtag');
  });

  it('[FR-007] remote-win adopts the whole remote frontmatter block (no union)', () => {
    const c = writeContent(resolver('remote-win', 'merge').decide('note.md', BASE, LOCAL, REMOTE, ctx()));
    expect(c).toContain('rtag');
    expect(c).not.toContain('ltag');
  });

  it('[FR-007] latest-mtime adopts the newer side frontmatter block', () => {
    const remoteNewer = writeContent(resolver('latest-mtime', 'merge').decide('note.md', BASE, LOCAL, REMOTE, ctx({ localMtime: 0, remoteMtime: 9 })));
    expect(remoteNewer).toContain('rtag');
    expect(remoteNewer).not.toContain('ltag');
  });

  it('[FR-007] biggest-size adopts the larger frontmatter block; a tie falls back to latest-mtime (never no-op)', () => {
    // local frontmatter longer (two extra tags) → biggest-size picks local regardless of mtime.
    const bigLocal = withFm(['work', 'l1', 'l2', 'l3'], 'B');
    const smallRemote = withFm(['work', 'r1'], 'B');
    const c = writeContent(resolver('biggest-size', 'merge').decide('note.md', BASE, bigLocal, smallRemote, ctx({ localMtime: 0, remoteMtime: 9 })));
    expect(c).toContain('l1');
    expect(c).not.toContain('r1');
  });
});

describe('feature 047 — convergence / idempotence (FR-013)', () => {
  it('[FR-013] re-resolving the converged content adds no tags and no markers', () => {
    // Use a clean body strategy so the first resolution converges cleanly (a merge body conflict would
    // write markers, which the re-entrancy guard then safe-holds — a separate, correct behaviour).
    const r = resolver('merge', 'latest-mtime');
    const first = writeContent(r.decide('note.md', BASE, LOCAL, REMOTE, ctx({ localMtime: 2, remoteMtime: 1 })));
    // Feed the converged result back in as BOTH sides (next sync sees both devices agree).
    const second = r.decide('note.md', first, first, first, ctx({ localMtime: 3, remoteMtime: 2 }));
    expect(second.action).toBe('write');
    const c = writeContent(second);
    // Same tag set, no duplication, no markers.
    expect((c.match(/ltag/g) ?? []).length).toBe(1);
    expect((c.match(/rtag/g) ?? []).length).toBe(1);
    expect(c).not.toMatch(/^<<<<<<< /m);
  });
});

describe('feature 047 — a frontmatter-only conflict never marks the file conflicted', () => {
  it('[C6] identical body + diverging frontmatter under merge → clean write', () => {
    const local = withFm(['work', 'ltag'], 'SameBody');
    const remote = withFm(['work', 'rtag'], 'SameBody');
    const r = resolver('merge', 'merge').decide('note.md', BASE, local, remote, ctx());
    expect(r.action).toBe('write');
    if (r.action === 'write') expect(r.clean).toBe(true);
  });
});
