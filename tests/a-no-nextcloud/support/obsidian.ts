// Obsidian API mock for Jest
import { load, dump } from 'js-yaml';

export class Plugin {
  app: App;
  manifest: PluginManifest;
  constructor(app: App, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }
  async loadData(): Promise<unknown> { return {}; }
  async saveData(_data: unknown): Promise<void> {}
  addStatusBarItem(): HTMLElement { return document.createElement('div'); }
  addSettingTab(_tab: unknown): void {}
  registerInterval(_id: number): number { return _id; }
}

export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl: HTMLElement;
  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement('div');
  }
  display(): void {}
}

/**
 * Test double for Obsidian's Notice. Captures the latest message, the construction
 * timeout, and dismissal so unit tests can assert message transitions and lifecycle.
 * `Notice.instances` records every constructed toast (newest last) to verify the
 * single-toast invariant.
 */
export class Notice {
  static instances: Notice[] = [];
  message: string;
  timeout: number | undefined;
  hidden = false;

  constructor(message: string, timeout?: number) {
    this.message = message;
    this.timeout = timeout;
    Notice.instances.push(this);
  }

  setMessage(message: string): this {
    this.message = message;
    return this;
  }

  hide(): void {
    this.hidden = true;
  }
}

export class Modal {
  app: App;
  contentEl: HTMLElement;
  constructor(app: App) {
    this.app = app;
    this.contentEl = document.createElement('div');
  }
  open(): void {}
  close(): void {}
}

export class TFile {
  path: string;
  basename: string;
  extension: string;
  parent: { path: string } | null;
  stat: { ctime: number; mtime: number; size: number };
  constructor(path: string, stat?: { ctime?: number; mtime?: number; size?: number }) {
    this.path = path;
    const parts = path.split('/');
    const filename = parts[parts.length - 1];
    const dotIdx = filename.lastIndexOf('.');
    this.basename = dotIdx >= 0 ? filename.slice(0, dotIdx) : filename;
    this.extension = dotIdx >= 0 ? filename.slice(dotIdx + 1) : '';
    this.parent = parts.length > 1 ? { path: parts.slice(0, -1).join('/') } : null;
    this.stat = { ctime: stat?.ctime ?? 0, mtime: stat?.mtime ?? 0, size: stat?.size ?? 0 };
  }
}

export class TFolder {
  path: string;
  name: string;
  parent: { path: string } | null;
  constructor(path: string) {
    this.path = path;
    const parts = path.split('/');
    this.name = parts[parts.length - 1];
    this.parent = parts.length > 1 ? { path: parts.slice(0, -1).join('/') } : null;
  }
}

export const requestUrl = jest.fn(
  (_req: RequestUrlParam): Promise<RequestUrlResponse> =>
    Promise.resolve({ status: 200, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} }),
);

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
}

export interface App {
  vault: Vault;
  fileManager: FileManager;
  saveLocalStorage(key: string, value: string | null): void;
  loadLocalStorage(key: string): string | null;
}

export interface FileManager {
  trashFile(file: TFile | TFolder): Promise<void>;
}

export interface Vault {
  adapter: DataAdapter;
  getAbstractFileByPath(path: string): TFile | TFolder | null;
  getFiles(): TFile[];
  trash(file: TFile, system: boolean): Promise<void>;
}

export interface DataAdapter {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
}

/**
 * Minimal element double tracking only attributes. The `node` jest environment has
 * no `document`, so we cannot use real DOM nodes; this is enough to assert where a
 * tooltip's `aria-label` lands (name element vs. whole row).
 */
export class FakeEl {
  private attrs = new Map<string, string>();
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  getAttribute(key: string): string | null { return this.attrs.has(key) ? this.attrs.get(key)! : null; }
  hasAttribute(key: string): boolean { return this.attrs.has(key); }
  removeAttribute(key: string): void { this.attrs.delete(key); }
}

/**
 * Faithful Setting double for Obsidian 1.12.7. Crucially, `setTooltip` labels only
 * `nameEl` (verified against the shipped obsidian.asar: `Setting.setTooltip` calls
 * the internal helper on `this.nameEl`). This lets tests prove the row-level
 * tooltip fix actually moves the label off the narrow name onto `settingEl`.
 */
export class Setting {
  settingEl = new FakeEl();
  infoEl = new FakeEl();
  nameEl = new FakeEl();
  descEl = new FakeEl();
  controlEl = new FakeEl();
  constructor(_containerEl: HTMLElement) {}
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  setHeading(): this { return this; }
  setTooltip(tooltip: string): this { setTooltip(this.nameEl, tooltip); return this; }
  addText(_cb: (_text: TextComponent) => void): this { return this; }
  addToggle(_cb: (_toggle: ToggleComponent) => void): this { return this; }
  addSlider(_cb: (_slider: SliderComponent) => void): this { return this; }
  addButton(_cb: (_btn: ButtonComponent) => void): this { return this; }
}

/** Obsidian's exported tooltip helper: sets `aria-label` on the given element. */
export function setTooltip(el: FakeEl, tooltip: string): void {
  el.setAttribute('aria-label', tooltip);
}

export interface TextComponent {
  setValue(value: string): this;
  getValue(): string;
  onChange(cb: (value: string) => void): this;
  setPlaceholder(placeholder: string): this;
}

export interface ToggleComponent {
  setValue(value: boolean): this;
  getValue(): boolean;
  onChange(cb: (value: boolean) => void): this;
}

export interface SliderComponent {
  setValue(value: number): this;
  getValue(): number;
  setLimits(min: number, max: number, step: number): this;
  onChange(cb: (value: number) => void): this;
}

export interface ButtonComponent {
  setButtonText(text: string): this;
  onClick(cb: () => void): this;
  setCta(): this;
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * Test double for Obsidian's `parseYaml`. Wraps js-yaml's `load`. Obsidian returns
 * `null` for empty / whitespace-only input; this js-yaml build throws on empty input,
 * so we short-circuit that case to preserve Obsidian's contract.
 */
export function parseYaml(s: string): any {
  if (s == null) return null;
  if (s.trim() === '') return null;
  return load(s);
}

/**
 * Test double for Obsidian's `stringifyYaml`. Wraps js-yaml's `dump`. `lineWidth: -1`
 * disables line folding so arrays / long scalars serialize deterministically (matching
 * Obsidian's own stable output and keeping round-trips lossless).
 */
export function stringifyYaml(obj: any): string {
  return dump(obj, { lineWidth: -1 });
}

/** Mirror of Obsidian's `FrontMatterInfo` (obsidian.d.ts). */
export interface FrontMatterInfo {
  /** Whether this file has a frontmatter block. */
  exists: boolean;
  /** String representation of the frontmatter (the YAML between the `---` fences, excluding them). */
  frontmatter: string;
  /** Start of the frontmatter contents (excluding the opening `---`). */
  from: number;
  /** End of the frontmatter contents (excluding the closing `---`). */
  to: number;
  /** Offset where the frontmatter block ends (including the closing `---` and its newline). */
  contentStart: number;
}

/**
 * Test double for Obsidian's `getFrontMatterInfo`. Recognizes a leading `---` fenced
 * YAML block only (a `---` appearing later in the body is a thematic break, never a
 * fence). CRLF and LF line endings are both accepted. `from`/`to` bound the inner YAML
 * text; `contentStart` is where the note body begins after the closing fence.
 */
export function getFrontMatterInfo(content: string): FrontMatterInfo {
  const none: FrontMatterInfo = { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
  if (content == null) return none;
  // Opening fence must be at the very start: `---` (optional trailing spaces) then a newline.
  const open = /^---[^\S\r\n]*\r?\n/.exec(content);
  if (!open) return none;
  const from = open[0].length;
  const rest = content.slice(from);
  // Empty frontmatter: the closing fence immediately follows the opening one.
  const immediate = /^---[^\S\r\n]*(?:\r?\n|$)/.exec(rest);
  if (immediate) {
    return { exists: true, frontmatter: '', from, to: from, contentStart: from + immediate[0].length };
  }
  // Otherwise the closing fence is the first `---` line after the opening fence.
  const close = /\r?\n---[^\S\r\n]*(?:\r?\n|$)/.exec(rest);
  if (!close) return none; // unterminated block: not valid frontmatter
  const to = from + close.index;
  const contentStart = from + close.index + close[0].length;
  return { exists: true, frontmatter: content.slice(from, to), from, to, contentStart };
}

/**
 * Test double for Obsidian's `parseFrontMatterStringArray`. Given an already-parsed
 * frontmatter object and a key (string or RegExp), returns the value normalized to a
 * string array: a single scalar becomes a one-element array, inline (`[a, b]`) and
 * block YAML lists both arrive here as arrays, each entry is coerced to string,
 * trimmed, and a leading `#` (tag sigil) is stripped. Returns `null` when the key is
 * absent or its value is null. Duplicates are intentionally preserved (callers dedup).
 */
export function parseFrontMatterStringArray(frontmatter: any, key: string | RegExp): string[] | null {
  if (frontmatter == null || typeof frontmatter !== 'object') return null;
  let value: any = null;
  if (key instanceof RegExp) {
    for (const k of Object.keys(frontmatter)) {
      if (key.test(k)) { value = frontmatter[k]; break; }
    }
  } else if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
    value = frontmatter[key];
  }
  if (value == null) return null;
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    if (item == null) continue;
    let s: string;
    if (typeof item === 'string') s = item;
    else if (typeof item === 'number' || typeof item === 'boolean') s = String(item);
    else continue;
    s = s.trim().replace(/^#/, '');
    if (s.length > 0) out.push(s);
  }
  return out;
}

// Mutable platform flags so tests can simulate desktop / iOS / Android.
export const Platform = {
  isMobile: false,
  isDesktop: true,
  isDesktopApp: true,
  isIosApp: false,
  isAndroidApp: false,
};
