// PERF BENCHMARK (manual, b-1 live): current full-scan getFiles('') Depth:infinity vs an ETag
// directory-propagation skip walk (PROPFIND Depth:1 from the root, pruning subtrees whose ETag
// matches the stored one). Self-contained: the skip walk is implemented here (raw requestUrl +
// the shared hrefToRelative util) so src/ carries no un-wired prototype.
//
// Measures round-trips, transferred bytes (decompressed XML the client must parse) and wall time
// for four scenarios against the real Nextcloud at NEXTCLOUD_SERVER_URL. Manual only:
//   pnpm test:b1 -- etagSkip.perf
// Skips cleanly when live env is absent. Builds an isolated tree, prints a report, then deletes it.

import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { hrefToRelative } from '../../../src/network/remotePath';
import { describeLive } from '../support/env';
import { makeClient, baseUrlOf, authHeaderOf } from '../support/clientFactory';
import { requestUrl } from 'obsidian';

// ── tree shape: branching 3 × depth 4 × 3 files/dir ⇒ 120 dirs + 363 files (~"400 files / 4 levels")
const BRANCHING = 3;
const DEPTH = 4;
const FILES_PER_DIR = 3;
const REPS = 3; // measured repetitions (median), plus 1 warmup
const POOL = 16; // upload concurrency

// Same PROPFIND body the production NextcloudClient uses, so the per-entry response size (and thus
// the byte comparison vs the baseline scan) is apples-to-apples.
const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:getetag/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/><d:sync-token/><oc:checksums/><oc:fileid/>
  </d:prop>
</d:propfind>`;

interface Stats { calls: number; byMethod: Record<string, number>; }
type FetchFn = (...args: unknown[]) => Promise<Response>;
function setFetch(fn: FetchFn): void { (globalThis as unknown as { fetch: FetchFn }).fetch = fn; }
function getFetch(): FetchFn { return (globalThis as unknown as { fetch: FetchFn }).fetch; }

/** Count round-trips by HTTP method (cheap; no body double-read ⇒ does not inflate timing). */
function instrumentCalls(): { stats: Stats; restore: () => void } {
  const orig = getFetch();
  const stats: Stats = { calls: 0, byMethod: {} };
  setFetch(async (...args: unknown[]) => {
    stats.calls++;
    const init = args[1] as { method?: string } | undefined;
    const m = (init?.method ?? 'GET').toUpperCase();
    stats.byMethod[m] = (stats.byMethod[m] ?? 0) + 1;
    return orig(...args);
  });
  return { stats, restore: () => setFetch(orig) };
}

/** Sum of decompressed response bytes for one run (separate untimed pass — reads bodies). */
async function auditBytes(run: () => Promise<unknown>): Promise<number> {
  const orig = getFetch();
  let bytes = 0;
  setFetch(async (...args: unknown[]) => {
    const resp = await orig(...args);
    try { bytes += (await resp.clone().arrayBuffer()).byteLength; } catch { /* ignore */ }
    return resp;
  });
  try { await run(); } finally { setFetch(orig); }
  return bytes;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

/** Deterministic file list (vault-relative paths). */
function genFiles(): string[] {
  const files: string[] = [];
  const walk = (prefix: string, depth: number): void => {
    for (let f = 0; f < FILES_PER_DIR; f++) files.push(`${prefix ? prefix + '/' : ''}f${f}.md`);
    if (depth > 0) for (let c = 0; c < BRANCHING; c++) walk(`${prefix ? prefix + '/' : ''}d${c}`, depth - 1);
  };
  walk('', DEPTH);
  return files;
}

/** Unique parent directories of a file list, shallow-first. */
function dirsOf(files: string[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    const parts = f.split('/'); parts.pop();
    let acc = '';
    for (const p of parts) { acc = acc ? `${acc}/${p}` : p; set.add(acc); }
  }
  return [...set].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

function enc(s: string): ArrayBuffer { return new TextEncoder().encode(s).buffer as ArrayBuffer; }

describeLive('PERF: ETag directory-propagation skip vs full scan', (getEnv) => {
  const env = getEnv();
  const runFolder = `etag-perf-${Date.now()}`;
  const remoteBase = env.syncFolder ? `${env.syncFolder}/${runFolder}` : runFolder;
  const baseUrl = baseUrlOf(env);
  const auth = authHeaderOf(env);
  let client: NextcloudClient;
  const files = genFiles();
  const dirs = dirsOf(files);
  let dirEtags = new Map<string, string>(); // pristine (pre-change) dir path → etag

  /** Collection URL for a vault-relative dir path (handles the space in "plugin test"). */
  function collUrl(rel: string): string {
    const full = rel ? `${remoteBase}/${rel}` : remoteBase;
    return `${baseUrl}/${full.split('/').filter(Boolean).map(encodeURIComponent).join('/')}/`;
  }

  /** Parse a Depth:1 multistatus into immediate child files + child dirs (excludes the dir itself). */
  function parseDepth1(xml: string, dirPath: string): { files: string[]; dirs: { path: string; etag: string | null }[] } {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');
    const outFiles: string[] = [];
    const outDirs: { path: string; etag: string | null }[] = [];
    for (let i = 0; i < responses.length; i++) {
      const resp = responses[i];
      const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
      const rel = hrefToRelative(baseUrl, remoteBase, href);
      if (rel === null || rel === '' || rel === dirPath) continue; // outside base / base itself / scanned dir
      const prop = resp.getElementsByTagNameNS('DAV:', 'prop')[0];
      if (!prop) continue;
      const rt = prop.getElementsByTagNameNS('DAV:', 'resourcetype')[0];
      const isColl = (rt?.getElementsByTagNameNS('DAV:', 'collection').length ?? 0) > 0;
      if (isColl) {
        const etag = prop.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent?.replace(/"/g, '') ?? null;
        outDirs.push({ path: rel, etag });
      } else {
        outFiles.push(rel);
      }
    }
    return { files: outFiles, dirs: outDirs };
  }

  /** ETag-skip walk: Depth:1 from root, pruning subtrees whose stored ETag matches. Returns all file paths. */
  async function scanSkip(dirPath: string, stored: Map<string, string>): Promise<string[]> {
    const res = await requestUrl({
      url: collUrl(dirPath), method: 'PROPFIND',
      headers: { Authorization: auth, Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY, throw: false,
    });
    if (res.status === 404) return [];
    if (res.status !== 207) throw new Error(`PROPFIND ${dirPath} -> HTTP ${res.status}`);
    const { files: childFiles, dirs: childDirs } = parseDepth1(res.text, dirPath);
    const out = [...childFiles];
    for (const d of childDirs) {
      const prev = stored.get(d.path);
      if (prev && d.etag && prev === d.etag) continue; // ETag match ⇒ whole subtree unchanged
      out.push(...await scanSkip(d.path, stored));
    }
    return out;
  }

  beforeAll(async () => {
    client = makeClient(env, remoteBase);
    await client.connect();
    // 1) create dirs sequentially shallow-first (parallel MKCOL races on shared ancestors ⇒ 404/409)
    for (const d of dirs) await client.createDirectory(d);
    // 2) upload files in parallel (all dirs exist ⇒ no reactive-MKCOL races)
    await pool(files, POOL, (p) => client.uploadFile(p, enc(`# ${p}\ncontent for ${p}\n`)));
    // 3) capture pristine dir ETag map (what StateDB.remoteEtag would hold after a full scan)
    const remoteDirs = await client.getDirectories('');
    dirEtags = new Map(remoteDirs.filter((d) => d.etag).map((d) => [d.path, d.etag as string]));
  }, 600_000);

  afterAll(async () => {
    await requestUrl({ url: collUrl(''), method: 'DELETE', headers: { Authorization: auth }, throw: false }).catch(() => undefined);
  }, 120_000);

  async function bench(run: () => Promise<unknown>): Promise<{ ms: number; rt: number; byMethod: Record<string, number>; bytes: number }> {
    await run(); // warmup
    const times: number[] = []; const rts: number[] = [];
    let lastByMethod: Record<string, number> = {};
    for (let r = 0; r < REPS; r++) {
      const inst = instrumentCalls();
      const t0 = performance.now();
      await run();
      times.push(performance.now() - t0);
      inst.restore();
      rts.push(inst.stats.calls); lastByMethod = inst.stats.byMethod;
    }
    const bytes = await auditBytes(run);
    return { ms: Math.round(median(times)), rt: median(rts), byMethod: lastByMethod, bytes };
  }

  it('benchmarks full-scan vs ETag-skip', async () => {
    const report: string[] = [];
    report.push(`\n=== ETag-skip perf @ ${env.serverUrl} ===`);
    report.push(`tree: ${dirs.length} dirs, ${files.length} files, depth ${DEPTH}, branching ${BRANCHING}, reps ${REPS} (median)\n`);

    const A_files = await bench(() => client.getFiles(''));            // A1 baseline files (Depth:infinity)
    const A_dirs = await bench(() => client.getDirectories(''));        // A2 baseline dirs (Depth:infinity)
    const B = await bench(() => scanSkip('', new Map()));               // cold (empty map ⇒ full recursion)
    const C = await bench(() => scanSkip('', dirEtags));                // warm, no change (prune all)
    const deepFile = files.filter((f) => f.split('/').length === DEPTH + 1)[0] ?? files[files.length - 1];
    await client.uploadFile(deepFile, enc(`# ${deepFile}\nCHANGED ${Date.now()}\n`));
    const D = await bench(() => scanSkip('', dirEtags));                // warm, one deep file changed

    const row = (name: string, b: { ms: number; rt: number; byMethod: Record<string, number>; bytes: number }): string =>
      `${name.padEnd(34)} | ${String(b.rt).padStart(4)} RT | ${String(Math.round(b.bytes / 1024)).padStart(7)} KB | ${String(b.ms).padStart(6)} ms | ${JSON.stringify(b.byMethod)}`;

    report.push('scenario                           |   RT |   bytes |   time | methods');
    report.push('-'.repeat(110));
    report.push(row('A1 baseline getFiles infinity', A_files));
    report.push(row('A2 baseline getDirectories inf', A_dirs));
    report.push(row('A  baseline combined (A1+A2)', {
      ms: A_files.ms + A_dirs.ms, rt: A_files.rt + A_dirs.rt, bytes: A_files.bytes + A_dirs.bytes, byMethod: { PROPFIND: 2 },
    }));
    report.push(row('B  etag-skip COLD (bootstrap)', B));
    report.push(row('C  etag-skip WARM no-change', C));
    report.push(row('D  etag-skip WARM 1 deep change', D));
    report.push('-'.repeat(110));

    const baseCount = (await client.getFiles('')).length;
    const coldCount = (await scanSkip('', new Map())).length;
    report.push(`\nsanity: baseline files=${baseCount} | cold skip-walk files=${coldCount} (must match)`);

    const reportRes = await requestUrl({
      url: collUrl(''), method: 'REPORT',
      headers: { Authorization: auth, 'Content-Type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:sync-level>infinite</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
      throw: false,
    });
    report.push(`\nF1 sync-collection REPORT status = ${reportRes.status} ${reportRes.status === 415 ? '(415 ⇒ unsupported: EVERY sync full-scans — ETag-skip is mainline, not fallback)' : '(supported ⇒ incremental works; ETag-skip is fallback-only)'}`);

    // eslint-disable-next-line no-console -- this IS the benchmark output
    console.log(report.join('\n'));
    expect(coldCount).toBe(baseCount);
  }, 600_000);
});
