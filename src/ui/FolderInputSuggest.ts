import { AbstractInputSuggest, App } from 'obsidian';
import { filterExcludableFolders } from '../util/excludedFolders';

/**
 * Inline dropdown suggester for the "Add excluded folder" text input (feature 029). As the user
 * types, it offers vault folders that are NOT already excluded and whose path contains the typed
 * text; picking one fills the input and notifies via `onPick`. The candidate logic is delegated to
 * the pure `filterExcludableFolders`, so only the thin Obsidian glue lives here.
 */
export class FolderInputSuggest extends AbstractInputSuggest<string> {
  constructor(
    private readonly suggestApp: App,
    textInputEl: HTMLInputElement,
    private readonly getExcluded: () => readonly string[],
    onPick: (path: string) => void,
  ) {
    super(suggestApp, textInputEl);
    this.onSelect((value) => {
      this.setValue(value);
      onPick(value);
      this.close();
    });
  }

  protected getSuggestions(query: string): string[] {
    const all = this.suggestApp.vault.getAllFolders(true).map((f) => f.path);
    return filterExcludableFolders(all, this.getExcluded(), query);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }
}
