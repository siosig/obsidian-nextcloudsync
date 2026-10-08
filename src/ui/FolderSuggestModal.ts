import { App, FuzzySuggestModal, TFolder } from 'obsidian';

// Choosing the vault root yields an empty string (logs then live at the vault root).
export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  constructor(app: App, private readonly onChoose: (path: string) => void) {
    super(app);
    this.setPlaceholder('Select a folder for log files…');
  }

  getItems(): TFolder[] {
    return this.app.vault.getAllFolders(true);
  }

  getItemText(folder: TFolder): string {
    // The root folder has an empty path; show it as "/" so it is selectable and visible.
    return folder.path === '' || folder.path === '/' ? '/ (vault root)' : folder.path;
  }

  onChooseItem(folder: TFolder): void {
    const path = folder.path === '/' ? '' : folder.path;
    this.onChoose(path);
  }
}
