import { DataAdapter } from 'obsidian';

// DataAdapter.write throws when the parent folder is missing, so writers targeting a user-chosen
// subfolder must create it first.
export async function ensureParentFolder(adapter: DataAdapter, path: string): Promise<void> {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return;
  const parent = path.slice(0, slash);
  if (!(await adapter.exists(parent))) {
    await adapter.mkdir(parent);
  }
}
