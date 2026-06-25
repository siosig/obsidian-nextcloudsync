// [SPEC:TN-1..TN-8] specs/main/spec.md — atomic-write temp-file naming under the 255-byte NAME_MAX.
// The temp file must NOT inherit the target's length: a final name within 255 bytes must always
// write, even when `target + legacy-suffix` would have exceeded 255 (the Android FILE_NOTCREATED bug).
// Only a final name that itself exceeds 255 bytes is unwritable; that case yields a friendly error.
import { DataAdapter } from 'obsidian';
import { LocalAdapter, isSyncTmpPath, tmpPathFor } from '../../../src/data/LocalAdapter';

const NAME_MAX = 255;
const buf = (n: number): ArrayBuffer => new Uint8Array(n).buffer;
const lastComponent = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const byteLen = (s: string): number => new TextEncoder().encode(s).length;
/** ASCII filename of exactly `n` UTF-8 bytes ending in `.md` (1 byte per char). */
const nameOfBytes = (n: number): string => 'a'.repeat(n - 3) + '.md';

interface Recorder { writes: string[]; renames: Array<[string, string]>; }

/**
 * In-memory DataAdapter that mimics Android's per-component 255-byte limit: any path whose final
 * component exceeds 255 UTF-8 bytes is rejected with a FILE_NOTCREATED-like error on create/rename.
 */
function fakeFsAdapter(rec: Recorder, statOverride?: () => Promise<{ size: number; mtime: number } | null>): DataAdapter {
  const sizes = new Map<string, number>();
  const enforce = (p: string): void => {
    if (byteLen(lastComponent(p)) > NAME_MAX) {
      throw new Error('FILE_NOTCREATED'); // Obsidian Android surfaces ENAMETOOLONG as this code
    }
  };
  return {
    write: jest.fn(async (p: string, c: string) => { enforce(p); rec.writes.push(p); sizes.set(p, c.length); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { enforce(p); rec.writes.push(p); sizes.set(p, d.byteLength); }),
    exists: jest.fn(async (p: string) => sizes.has(p)),
    remove: jest.fn(async (p: string) => { sizes.delete(p); }),
    rename: jest.fn(async (f: string, t: string) => { enforce(t); rec.renames.push([f, t]); sizes.set(t, sizes.get(f)!); sizes.delete(f); }),
    stat: jest.fn(statOverride ?? (async (p: string) => (sizes.has(p) ? { size: sizes.get(p)!, mtime: 0 } : null))),
    mkdir: jest.fn(), read: jest.fn(), readBinary: jest.fn(), list: jest.fn(),
  } as unknown as DataAdapter;
}

const newRec = (): Recorder => ({ writes: [], renames: [] });

describe('[SPEC:TN-1] final name within 255 bytes always writes (no temp-suffix length leak)', () => {
  it.each([4, 100, 243, NAME_MAX])('TN-1 atomicWrite succeeds for a %i-byte final name', async (n) => {
    const rec = newRec();
    const la = new LocalAdapter(fakeFsAdapter(rec));
    const target = `dir/${nameOfBytes(n)}`;
    await expect(la.atomicWrite(target, 'x')).resolves.toBeUndefined();
    // The temp file that was actually written must itself be within the limit.
    expect(rec.writes.every((p) => byteLen(lastComponent(p)) <= NAME_MAX)).toBe(true);
  });

  it('TN-1 atomicWriteBinary succeeds for a 243-byte final name (the reported bug)', async () => {
    const rec = newRec();
    const la = new LocalAdapter(fakeFsAdapter(rec));
    await expect(la.atomicWriteBinary(`dir/${nameOfBytes(243)}`, buf(5))).resolves.toBeUndefined();
  });
});

describe('[SPEC:TN-2] temp name length does not depend on the target name length', () => {
  it('TN-2 temp basename byte-length is the same for a short and a 243-byte target', () => {
    const shortTmp = lastComponent(tmpPathFor('dir/a.md'));
    const longTmp = lastComponent(tmpPathFor(`dir/${nameOfBytes(243)}`));
    expect(byteLen(shortTmp)).toBe(byteLen(longTmp));
    expect(byteLen(longTmp)).toBeLessThanOrEqual(NAME_MAX);
  });
});

describe('[SPEC:TN-3][SPEC:TN-4] temp names are unique per target and deterministic', () => {
  it('TN-3 two different targets in the same directory get different temp names', () => {
    const a = tmpPathFor(`dir/${nameOfBytes(243)}`);
    const b = tmpPathFor(`dir/${'b'.repeat(240)}.md`);
    expect(a).not.toBe(b);
    // Same parent directory (atomic rename stays in-dir).
    expect(a.slice(0, a.lastIndexOf('/'))).toBe(b.slice(0, b.lastIndexOf('/')));
  });
  it('TN-4 the same target always maps to the same temp name', () => {
    expect(tmpPathFor('dir/note.md')).toBe(tmpPathFor('dir/note.md'));
  });
});

describe('[SPEC:TN-5] temp file is in the same directory as the target (atomic rename)', () => {
  it('TN-5 rename source and destination share the same parent directory', async () => {
    const rec = newRec();
    const la = new LocalAdapter(fakeFsAdapter(rec));
    await la.atomicWrite('a/b/c/note.md', 'x');
    const [from, to] = rec.renames[0];
    const parent = (p: string): string => p.slice(0, p.lastIndexOf('/'));
    expect(parent(from)).toBe(parent(to));
    expect(parent(to)).toBe('a/b/c');
  });
});

describe('[SPEC:TN-6] a final name that itself exceeds 255 bytes yields a friendly error', () => {
  it.each([256, 300])('TN-6 atomicWrite on a %i-byte final name reports bytes, the 255 limit, and to shorten', async (n) => {
    const la = new LocalAdapter(fakeFsAdapter(newRec()));
    await expect(la.atomicWrite(`dir/${nameOfBytes(n)}`, 'x')).rejects.toThrow(
      new RegExp(`${n}\\b.*255|255.*\\b${n}\\b`),
    );
    await expect(la.atomicWrite(`dir/${nameOfBytes(n)}`, 'x')).rejects.toThrow(/short/i);
  });
  it('TN-6 atomicWriteBinary on a 256-byte final name is also translated', async () => {
    const la = new LocalAdapter(fakeFsAdapter(newRec()));
    await expect(la.atomicWriteBinary(`dir/${nameOfBytes(256)}`, buf(5))).rejects.toThrow(/255/);
  });
});

describe('[SPEC:TN-7] non-length errors are not swallowed by the translation', () => {
  it('TN-7 write-back verification failure (final name <=255) rethrows the original error', async () => {
    // stat lies (3 != 5) so the read-back check fails; the name is short so it must NOT be re-labelled.
    const la = new LocalAdapter(fakeFsAdapter(newRec(), async () => ({ size: 3, mtime: 0 })));
    await expect(la.atomicWriteBinary('dir/note.md', buf(5))).rejects.toThrow(/write-back verification failed/);
  });
});

describe('[SPEC:TN-8] temp-path detection covers new + legacy suffixes, and temp is cleaned on failure', () => {
  it('TN-8 isSyncTmpPath matches both the new .ncs.tmp and the legacy .nextcloudsync.tmp', () => {
    expect(isSyncTmpPath('dir/.abc.ncs.tmp')).toBe(true);
    expect(isSyncTmpPath('dir/note.md.nextcloudsync.tmp')).toBe(true);
    expect(isSyncTmpPath('dir/note.md')).toBe(false);
  });
  it('TN-8 tmpPathFor output is recognised as a sync temp path', () => {
    expect(isSyncTmpPath(tmpPathFor('dir/note.md'))).toBe(true);
  });
  it('TN-8 a failed write leaves no temp file behind', async () => {
    const rec = newRec();
    const adapter = fakeFsAdapter(rec, async () => ({ size: 3, mtime: 0 })); // force write-back failure
    const la = new LocalAdapter(adapter);
    await expect(la.atomicWriteBinary('dir/note.md', buf(5))).rejects.toThrow();
    // After cleanup, the temp path must not exist.
    expect(await adapter.exists(tmpPathFor('dir/note.md'))).toBe(false);
  });
});
