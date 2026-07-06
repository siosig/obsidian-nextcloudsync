// G4-1 regression: atomicWrite/atomicWriteBinary must not delete the tmp file when `rename` fails
// AFTER the pre-existing target has already been removed — at that point tmpPath is the ONLY
// surviving copy of the new content (mobile process kill / Windows AV lock / storage blip mid-rename).
// Deleting it in the catch block would lose the data outright (neither old nor new content remains).
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { DataAdapter } from 'obsidian';

/** Fake adapter where `remove(target)` succeeds but the subsequent `rename` always throws — the
 *  exact crash window the bug targets. */
function makeCrashingAdapter(target: string) {
  const files = new Map<string, string | ArrayBuffer>();
  const adapter = {
    mkdir: jest.fn(async () => undefined),
    write: jest.fn(async (p: string, d: string) => { files.set(p, d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files.set(p, d); }),
    exists: jest.fn(async (p: string) => files.has(p)),
    remove: jest.fn(async (p: string) => { files.delete(p); }),
    rename: jest.fn(async () => { throw new Error('simulated crash: rename never completed'); }),
    stat: jest.fn(async (p: string) => {
      const v = files.get(p);
      return v instanceof ArrayBuffer ? { size: v.byteLength, mtime: 0 } : null;
    }),
  } as unknown as DataAdapter;
  return { adapter, files };
}

describe('[G4-1] atomicWrite/atomicWriteBinary must not delete the sole surviving tmp copy on a post-remove rename failure', () => {
  it('atomicWrite: rename fails after remove(target) — tmp is kept (not deleted) and the error still propagates', async () => {
    const target = 'Notes/hello.md';
    const { adapter, files } = makeCrashingAdapter(target);
    files.set(target, 'old content'); // pre-existing target so remove(target) actually runs
    const local = new LocalAdapter(adapter);

    await expect(local.atomicWrite(target, 'new content')).rejects.toThrow('simulated crash');

    // The old target is gone (remove() ran) — losing tmp too would mean total data loss.
    expect(await adapter.exists(target)).toBe(false);
    // Exactly one file remains: the tmp file holding the new content. It must NOT have been deleted.
    const remainingPaths = [...files.keys()];
    expect(remainingPaths).toHaveLength(1);
    expect(remainingPaths[0]).toMatch(/\.ncs\.tmp$/);
    expect(files.get(remainingPaths[0])).toBe('new content');
  });

  it('atomicWriteBinary: rename fails after remove(target) — tmp is kept (not deleted) and the error still propagates', async () => {
    const target = 'attachments/img.png';
    const { adapter, files } = makeCrashingAdapter(target);
    files.set(target, new ArrayBuffer(2)); // pre-existing target so remove(target) actually runs
    const local = new LocalAdapter(adapter);
    const newData = new ArrayBuffer(4);

    await expect(local.atomicWriteBinary(target, newData)).rejects.toThrow('simulated crash');

    expect(await adapter.exists(target)).toBe(false);
    const remainingPaths = [...files.keys()];
    expect(remainingPaths).toHaveLength(1);
    expect(remainingPaths[0]).toMatch(/\.ncs\.tmp$/);
    expect((files.get(remainingPaths[0]) as ArrayBuffer).byteLength).toBe(4);
  });

  it('still cleans up tmp on a failure BEFORE the target is removed (write failure), preserving the old target untouched', async () => {
    const target = 'Notes/fail.md';
    const files = new Map<string, string>();
    const adapter = {
      mkdir: jest.fn(async () => undefined),
      write: jest.fn(async () => { throw new Error('disk full'); }),
      exists: jest.fn(async (p: string) => files.has(p)),
      remove: jest.fn(async (p: string) => { files.delete(p); }),
      rename: jest.fn(async () => undefined),
    } as unknown as DataAdapter;
    files.set(target, 'old content');
    const local = new LocalAdapter(adapter);

    await expect(local.atomicWrite(target, 'new content')).rejects.toThrow('disk full');

    // The write to tmp itself failed, so remove(target) never ran: old content survives untouched,
    // and there is no leftover tmp file to clean up either way.
    expect(files.get(target)).toBe('old content');
  });
});
