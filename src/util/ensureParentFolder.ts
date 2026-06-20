import { DataAdapter } from 'obsidian';

/**
 * Create the parent folder of a vault path when it is missing, so that a first write to a
 * not-yet-existing subfolder does not fail. Obsidian's {@link DataAdapter.write} does not
 * create missing parent folders (it throws), so any writer targeting a user-chosen subfolder
 * must ensure the folder first — see {@link LocalAdapter}'s equivalent guard for the sync path.
 *
 * No-op for vault-root paths (no parent to create) and when the parent already exists.
 */
export async function ensureParentFolder(adapter: DataAdapter, path: string): Promise<void> {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return; // vault root → no parent folder to create
  const parent = path.slice(0, slash);
  if (!(await adapter.exists(parent))) {
    await adapter.mkdir(parent);
  }
}
