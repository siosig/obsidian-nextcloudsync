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

// Feature 062: eslint-plugin-obsidianmd@0.4.1 bumped the lint gate back in sync with the
// Obsidian community-directory reviewer and promoted obsidianmd/prefer-create-el to "error".
// This is a static regression guard for that promotion — it doesn't require running eslint.
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

// Feature 062: js-yaml is unused in production code (parseYaml/stringifyYaml cover it) and is
// only consumed by test doubles, so it belongs in devDependencies, not dependencies.
describe('[SPEC:SWC-4] js-yaml is classified as a devDependency, not a production dependency', () => {
  it('[SPEC:SWC-4] package.json keeps js-yaml out of dependencies and in devDependencies', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies).not.toHaveProperty('js-yaml');
    expect(pkg.devDependencies).toHaveProperty('js-yaml');
  });
});

// Feature 062: the local lint gate must stay pinned to the reviewer-equivalent plugin version —
// an older pin would let the reviewer flag Warnings the local pre-push gate silently misses.
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

// Feature 062: obsidianmd/prefer-create-el must be promoted to "error" (recommended ships "warn"),
// and obsidianmd/settings-tab/prefer-setting-definitions must be explicitly "off" with the
// spec-062 deferral reason recorded in eslint.config.mjs — not left at its default "warn".
describe('[SPEC:SWC-3] eslint.config.mjs pins prefer-create-el to error and defers prefer-setting-definitions', () => {
  it('[SPEC:SWC-3] the rule severities match the spec 062 gate-resync decision', () => {
    const config = readFileSync(join(REPO_ROOT, 'eslint.config.mjs'), 'utf8');
    expect(config).toMatch(/"obsidianmd\/prefer-create-el":\s*"error"/);
    expect(config).toMatch(/"obsidianmd\/settings-tab\/prefer-setting-definitions":\s*"off"/);
  });
});
