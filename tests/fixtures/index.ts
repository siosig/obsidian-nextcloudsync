// Shared fixture set for the test suites.
//
// Models the real-world file mix the plugin syncs: markdown is the overwhelming
// majority (>=90% of files), large binaries (pdf/image) are a small minority
// (<10%) used only for size-boundary / chunked / over-limit checks (FR-017).
//
// Non-secret international fixtures (Japanese path segments) are intentional
// functional data and must be preserved (repo language rule).

export type FixtureKind = 'md' | 'large';

export interface Fixture {
  /** Vault-relative path. */
  path: string;
  kind: FixtureKind;
  /** Approximate content size in bytes. */
  size: number;
}

const KB = 1024;
const MB = 1024 * 1024;

// 28 markdown files vs 2 large => md = 93.3% (>=90%), large = 6.7% (<10%).
export const FIXTURES: Fixture[] = [
  // --- markdown majority (incl. international path) ---
  ...Array.from({ length: 26 }, (_, i): Fixture => ({
    path: `notes/note-${String(i + 1).padStart(2, '0')}.md`,
    kind: 'md',
    size: 1 * KB,
  })),
  { path: 'メモ/テスト 🗂️.md', kind: 'md', size: 2 * KB }, // international functional fixture
  { path: 'daily/2026-06-21.md', kind: 'md', size: 4 * KB },
  // --- large minority (size-boundary / chunked / over-limit only) ---
  { path: 'attachments/diagram.png', kind: 'large', size: 3 * MB },
  { path: 'attachments/handbook.pdf', kind: 'large', size: 12 * MB },
];

export interface FixtureRatio {
  total: number;
  md: number;
  large: number;
  mdRatio: number;
  largeRatio: number;
}

/** Compute the md/large ratio of a fixture set (used by the ratio meta-test). */
export function fixtureRatio(fixtures: Fixture[] = FIXTURES): FixtureRatio {
  const total = fixtures.length;
  const md = fixtures.filter((f) => f.kind === 'md').length;
  const large = fixtures.filter((f) => f.kind === 'large').length;
  return { total, md, large, mdRatio: md / total, largeRatio: large / total };
}

/** Deterministic content for a fixture (no Math.random / Date — repeatable). */
export function fixtureContent(f: Fixture): Buffer {
  if (f.kind === 'md') {
    const body = `# ${f.path}\n\nfixture body\n`;
    const pad = Math.max(0, f.size - Buffer.byteLength(body));
    return Buffer.concat([Buffer.from(body, 'utf-8'), Buffer.alloc(pad, 0x20)]);
  }
  return Buffer.alloc(f.size, 0xab); // opaque binary blob for large fixtures
}
