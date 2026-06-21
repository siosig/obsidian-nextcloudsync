// Obsidian API mock for Jest
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

// Mutable platform flags so tests can simulate desktop / iOS / Android.
export const Platform = {
  isMobile: false,
  isDesktop: true,
  isDesktopApp: true,
  isIosApp: false,
  isAndroidApp: false,
};
