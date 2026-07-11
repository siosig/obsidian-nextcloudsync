// Issue #15: a background sync must not evict the user's open note. atomicWrite/atomicWriteBinary
// used to apply remote changes via write-tmp -> adapter.remove(target) -> adapter.rename, a physical
// delete+recreate that Obsidian's core reports as the file closing (empty pane), reproduced on a live
// instance in tests/b2-nextcloud-ui/scenarios/activeLeafSurvivesSync.b2.test.ts. When the target path
// is open in a leaf, LocalAdapter must instead update it in place via Vault.modify/modifyBinary (no
// delete event). When it is not open (or no Workspace was injected), the existing tmp-write ->
// remove -> rename atomicity must run completely unchanged.
import { LocalAdapter } from '../../../src/data/LocalAdapter';
import { DataAdapter, FileView, TFile, Vault, Workspace } from 'obsidian';

/** A minimal TFile double (real TFile has no public constructor usable from test code). */
function makeTFile(path: string): TFile {
  return { path } as unknown as TFile;
}

function makeAdapter() {
  const files = new Map<string, string | ArrayBuffer>();
  const adapter = {
    mkdir: jest.fn(async () => undefined),
    write: jest.fn(async (p: string, d: string) => { files.set(p, d); }),
    writeBinary: jest.fn(async (p: string, d: ArrayBuffer) => { files.set(p, d); }),
    exists: jest.fn(async (p: string) => files.has(p)),
    remove: jest.fn(async (p: string) => { files.delete(p); }),
    rename: jest.fn(async (from: string, to: string) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    }),
    stat: jest.fn(async (p: string) => {
      const v = files.get(p);
      if (v === undefined) return null;
      return { size: typeof v === 'string' ? v.length : v.byteLength, mtime: 0 };
    }),
  } as unknown as DataAdapter;
  return { adapter, files };
}

/**
 * A Workspace double whose single leaf shows `openPath` (or no leaf at all if `openPath` is null).
 * `FileView` is abstract and its real constructor takes a `WorkspaceLeaf` (obsidian.d.ts), so we
 * build the instance via its prototype rather than `new` — LocalAdapter's `instanceof FileView`
 * check only cares that the prototype chain matches, which this satisfies at runtime (both this
 * test and LocalAdapter resolve the same mocked 'obsidian' module under Jest's moduleNameMapper).
 */
function makeWorkspace(openPath: string | null, file: TFile | null): Workspace {
  const view = Object.create(FileView.prototype) as FileView;
  view.file = openPath ? file : null;
  const leaves = openPath ? [{ view }] : [];
  return {
    iterateAllLeaves: (callback: (leaf: { view: FileView }) => void) => leaves.forEach(callback),
  } as unknown as Workspace;
}

function makeVault(file: TFile): { vault: Vault; modify: jest.Mock; modifyBinary: jest.Mock } {
  const modify = jest.fn(async () => undefined);
  const modifyBinary = jest.fn(async () => undefined);
  const vault = {
    adapter: undefined as unknown as DataAdapter,
    getAbstractFileByPath: () => file,
    getFiles: () => [file],
    trash: jest.fn(),
    modify,
    modifyBinary,
  } as unknown as Vault;
  return { vault, modify, modifyBinary };
}

describe('[OL-1] text file open -> in-place vault.modify, no delete event', () => {
  it('applies the update via vault.modify and never touches adapter.remove/adapter.rename', async () => {
    const path = 'Notes/open.md';
    const file = makeTFile(path);
    const { adapter } = makeAdapter();
    const { vault, modify } = makeVault(file);
    const workspace = makeWorkspace(path, file);
    const local = new LocalAdapter(adapter, vault, workspace);

    await local.atomicWrite(path, 'remote content');

    expect(modify).toHaveBeenCalledWith(file, 'remote content');
    expect(adapter.remove).not.toHaveBeenCalled();
    expect(adapter.rename).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
  });
});

describe('[OL-2] binary file open -> in-place vault.modifyBinary, no delete event', () => {
  it('applies the update via vault.modifyBinary and never touches adapter.remove/adapter.rename', async () => {
    const path = 'attachments/open.png';
    const file = makeTFile(path);
    const { adapter } = makeAdapter();
    const { vault, modifyBinary } = makeVault(file);
    const workspace = makeWorkspace(path, file);
    const local = new LocalAdapter(adapter, vault, workspace);
    const data = new ArrayBuffer(4);

    await local.atomicWriteBinary(path, data);

    expect(modifyBinary).toHaveBeenCalledWith(file, data);
    expect(adapter.remove).not.toHaveBeenCalled();
    expect(adapter.rename).not.toHaveBeenCalled();
    expect(adapter.writeBinary).not.toHaveBeenCalled();
  });
});

describe('[OL-3] not-open file (or no workspace injected) -> existing tmp-write/remove/rename path, no vault.modify', () => {
  it('falls back to the atomic tmp-write path when no Workspace is injected at all', async () => {
    const path = 'Notes/no-workspace.md';
    const { adapter, files } = makeAdapter();
    files.set(path, 'old content');
    const local = new LocalAdapter(adapter); // workspace omitted entirely, as in existing callers

    await local.atomicWrite(path, 'new content');

    expect(adapter.remove).toHaveBeenCalledWith(path);
    expect(adapter.rename).toHaveBeenCalled();
    expect(files.get(path)).toBe('new content');
  });

  it('falls back to the atomic tmp-write path when a Workspace is injected but the path is not open', async () => {
    const path = 'Notes/not-open.md';
    const file = makeTFile(path);
    const { adapter, files } = makeAdapter();
    files.set(path, 'old content');
    const { vault, modify } = makeVault(file);
    const workspace = makeWorkspace(null, null); // no leaf open anywhere
    const local = new LocalAdapter(adapter, vault, workspace);

    await local.atomicWrite(path, 'new content');

    expect(modify).not.toHaveBeenCalled();
    expect(adapter.remove).toHaveBeenCalledWith(path);
    expect(adapter.rename).toHaveBeenCalled();
    expect(files.get(path)).toBe('new content');
  });

  it('falls back to the atomic tmp-write path for atomicWriteBinary when the path is not open', async () => {
    const path = 'attachments/not-open.png';
    const file = makeTFile(path);
    const { adapter, files } = makeAdapter();
    files.set(path, new ArrayBuffer(2));
    const { vault, modifyBinary } = makeVault(file);
    const workspace = makeWorkspace(null, null);
    const local = new LocalAdapter(adapter, vault, workspace);
    const data = new ArrayBuffer(4);

    await local.atomicWriteBinary(path, data);

    expect(modifyBinary).not.toHaveBeenCalled();
    expect(adapter.remove).toHaveBeenCalledWith(path);
    expect(adapter.rename).toHaveBeenCalled();
    expect((files.get(path) as ArrayBuffer).byteLength).toBe(4);
  });
});
