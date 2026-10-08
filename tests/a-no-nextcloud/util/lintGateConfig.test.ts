import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '../../..');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// eslint-plugin-obsidianmd@0.4.1 keeps the lint gate in sync with the Obsidian community-directory
// reviewer and promotes obsidianmd/prefer-create-el to "error". Static guard; does not run eslint.
describe('[SPEC:SWC-2] src/**/*.ts contains no createEl(\'div\'|\'span\', ...) calls', () => {
  it('[SPEC:SWC-2] every div/span DOM helper call uses createDiv()/createSpan(), not createEl()', () => {
    const offenders: string[] = [];
    const pattern = /createEl\(\s*['"](div|span)['"]/;
    for (const file of listTsFiles(join(REPO_ROOT, 'src'))) {
      const content = readFileSync(file, 'utf8');
      if (pattern.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// The community-directory reviewer flags js-yaml as a package to replace, so it must not be a direct
// dependency at all; it still arrives transitively, which the pnpm override keeps on a patched floor.
describe('[SPEC:SWC-4] js-yaml is not a direct dependency; test doubles use yaml', () => {
  it('[SPEC:SWC-4] package.json declares neither js-yaml nor @types/js-yaml, and has yaml in devDependencies', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    for (const section of [pkg.dependencies ?? {}, pkg.devDependencies ?? {}]) {
      expect(section).not.toHaveProperty('js-yaml');
      expect(section).not.toHaveProperty('@types/js-yaml');
    }
    const range: string = pkg.devDependencies.yaml;
    const match = /^\^2\.(\d+)\.(\d+)$/.exec(range);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(9);
  });

  it('[SPEC:SWC-4] the three Obsidian test doubles import yaml, not js-yaml', () => {
    const doubles = [
      'tests/a-no-nextcloud/support/obsidian.ts',
      'tests/b1-nextcloud-headless/__mocks__/obsidian.ts',
      'tests/b4-plain-webdav/__mocks__/obsidian.ts',
    ];
    for (const rel of doubles) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(/from\s+['"]yaml['"]/.test(src)).toBe(true);
      expect(/from\s+['"]js-yaml['"]|require\(\s*['"]js-yaml['"]/.test(src)).toBe(false);
    }
  });

  it('[SPEC:SWC-4] pnpm-workspace.yaml keeps the transitive js-yaml >=5.2.2 override', () => {
    const ws = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
    expect(/^\s*js-yaml:\s*'>=5\.2\.2'\s*$/m.test(ws)).toBe(true);
  });
});

// The local lint gate must stay pinned to the reviewer-equivalent plugin version; an older pin would let
// the reviewer flag Warnings the local pre-push gate silently misses.
describe('[SPEC:SWC-1] eslint-plugin-obsidianmd is pinned to the reviewer-equivalent version', () => {
  it('[SPEC:SWC-1] package.json devDependencies pin eslint-plugin-obsidianmd to ^0.4.1 (or newer)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const range: string = pkg.devDependencies['eslint-plugin-obsidianmd'];
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
    expect(match).not.toBeNull();
    const [, major, minor] = match as RegExpExecArray;
    expect(Number(major) > 0 || Number(minor) >= 4).toBe(true);
  });
});

// obsidianmd/prefer-create-el must be "error" (recommended ships "warn"), and
// obsidianmd/settings-tab/prefer-setting-definitions explicitly "off" with the deferral reason recorded in
// eslint.config.mjs, not left at its default "warn".
describe('[SPEC:SWC-3] eslint.config.mjs pins prefer-create-el to error and defers prefer-setting-definitions', () => {
  it('[SPEC:SWC-3] the rule severities match the spec 062 gate-resync decision', () => {
    const config = readFileSync(join(REPO_ROOT, 'eslint.config.mjs'), 'utf8');
    expect(config).toMatch(/"obsidianmd\/prefer-create-el":\s*"error"/);
    expect(config).toMatch(/"obsidianmd\/settings-tab\/prefer-setting-definitions":\s*"off"/);
  });
});
