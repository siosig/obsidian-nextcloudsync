import { parse as parseYamlText, stringify as stringifyYamlText } from 'yaml';

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

// Captures the latest message, timeout and dismissal. `Notice.instances` (newest last) lets tests verify
// the single-toast invariant.
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

// Real class so LocalAdapter's open-file detection has an `instanceof` target.
export class FileView {
  file: TFile | null = null;
}

export interface WorkspaceLeaf {
  view: FileView | Record<string, unknown>;
}

export interface Workspace {
  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => void): void;
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

// The `node` jest environment has no `document`, so elements only track attributes.
export class FakeEl {
  private attrs = new Map<string, string>();
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  getAttribute(key: string): string | null { return this.attrs.has(key) ? this.attrs.get(key)! : null; }
  hasAttribute(key: string): boolean { return this.attrs.has(key); }
  removeAttribute(key: string): void { this.attrs.delete(key); }
}

// Setting.setTooltip labels only `nameEl` (verified against Obsidian 1.12.7), so tests can prove the
// row-level tooltip fix moves the label onto `settingEl`.
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

// Obsidian returns null for empty / whitespace-only input; short-circuit it before the YAML library.
export function parseYaml(s: string): any {
  if (s == null) return null;
  if (s.trim() === '') return null;
  return parseYamlText(s);
}

// version '1.1' quotes scalars a YAML 1.1 reader would retype (yes, n, dates), matching the output the
// merge tests were written against; parse stays 1.2 core. lineWidth 0 disables folding.
const YAML_STRINGIFY_OPTIONS = { version: '1.1', singleQuote: true, lineWidth: 0 } as const;
export function stringifyYaml(obj: any): string {
  return stringifyYamlText(obj, YAML_STRINGIFY_OPTIONS);
}

export interface FrontMatterInfo {
  exists: boolean;
  frontmatter: string;
  // Start of the frontmatter contents (excluding the opening `---`).
  from: number;
  // End of the frontmatter contents (excluding the closing `---`).
  to: number;
  // Offset where the block ends (including the closing `---` and its newline).
  contentStart: number;
}

// Only a leading `---` fenced block counts (a later `---` is a thematic break); CRLF and LF are both
// accepted.
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

// Scalars become one-element arrays; entries are string-coerced and trimmed, with a leading `#`
// stripped. Null when absent. Duplicates are preserved (callers dedup).
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
