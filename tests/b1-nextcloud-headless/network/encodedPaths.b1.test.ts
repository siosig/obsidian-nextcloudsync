// Layer b-1 — [SPEC:URE-2] (GitHub issue #25): paths whose names need percent-encoding survive a full round-trip
// against a REAL Nextcloud. Unit tests assert only the URL string we build, not whether the SERVER agrees, and every
// failure in this bug's history was that disagreement (0.7.30/0.7.32 produced folders literally named `00%20<name>`;
// 0.7.33 sent a raw space and got 404). Upload+download alone would not catch it (both use the same encoder), so each
// case also asserts the name the server reports via PROPFIND (decoded by the independent hrefToRelative) and that NO
// entry carries a literal `%`.
import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { describeLive } from '../support/env';
import { cleanupWorkspace, IsolatedWorkspace } from '../support/isolation';
import { setupWorkspace } from '../support/workspace';
import { textBuf, buffersEqual } from '../support/helpers';

// The shapes issue #25 and PR #17 failed on, plus the reporter's control case.
const SPACE_IN_DIR = 'Directory Name/FileName.md';
const SPACE_IN_FILE = 'This Is A Note.md';
const SPACE_PLUS_CJK = '00 \u6536\u4ef6\u7bb1/\u672a\u547d\u540d.md';
const AMPERSAND = 'Test&Note.md'; // synced fine on the reporter's device — must not regress
const HASH_AND_PERCENT = 'a#b 50% done.md';
const EMOJI = '📁 folder/note 🎉.md';

describeLive('Layer b-1 — percent-encoded remote paths round-trip (feature 065, issue #25)', (getEnv) => {
  let ws: IsolatedWorkspace;
  let client: NextcloudClient;

  beforeAll(async () => {
    const s = await setupWorkspace(getEnv());
    ws = s.ws;
    client = s.client;
  });

  afterAll(async () => {
    if (client && ws) await cleanupWorkspace(client, ws);
  });

  it.each([
    ['space in the directory name', SPACE_IN_DIR],
    ['space in the file name', SPACE_IN_FILE],
    ['space + CJK (the PR #17 folder)', SPACE_PLUS_CJK],
    ['ampersand', AMPERSAND],
    ['hash and percent', HASH_AND_PERCENT],
    ['emoji (surrogate pairs)', EMOJI],
  ])('URE-2 %s: upload → PROPFIND reports the exact name → download returns the same bytes', async (_label, path) => {
    const data = textBuf(`body for ${path}`);
    await client.uploadFile(path, data);

    // Independent check: the server's own href, decoded by hrefToRelative, must equal what we asked
    // for. This is what fails when the request carried a double-encoded (or unencoded) path.
    const files = await client.getFiles('');
    expect(files.map((f) => f.path)).toContain(path);

    const back = await client.downloadFile(path);
    expect(buffersEqual(back, data)).toBe(true);
  });

  it('URE-2 no remote entry is created with a literal percent-encoded name', async () => {
    // The 0.7.30/0.7.32 failure mode: a second, wrongly-named folder (`00 <name>` AND `00%20<name>`) appears and the
    // divergence never self-heals. `%` cannot appear in any name here because no fixture directory name contains one.
    for (const p of [SPACE_IN_DIR, SPACE_PLUS_CJK, EMOJI]) {
      await client.uploadFile(p, textBuf('x'));
    }
    const files = await client.getFiles('');
    const dirs = await client.getDirectories('');
    expect(files.filter((f) => f.path.includes('%20'))).toHaveLength(0);
    expect(dirs.filter((d) => d.path.includes('%20'))).toHaveLength(0);
    expect(dirs.filter((d) => /%[0-9A-Fa-f]{2}/.test(d.path))).toHaveLength(0);
  });

  it('URE-2 MOVE renames between two names that both need encoding (Destination header)', async () => {
    // The Destination header is never touched by the request layer on any platform, so an
    // unencoded value there fails even where the request URL would have been repaired.
    const src = 'move me/from here.md';
    const dst = '00 \u6536\u4ef6\u7bb1/\u79fb\u52d5\u5148 file.md';
    const data = textBuf('moved');
    await client.uploadFile(src, data);
    await client.moveFile(src, dst);

    const files = await client.getFiles('');
    expect(files.map((f) => f.path)).toContain(dst);
    expect(files.map((f) => f.path)).not.toContain(src);
    expect(buffersEqual(await client.downloadFile(dst), data)).toBe(true);
  });

  it('URE-2 DELETE removes a space-containing path (no orphan left behind)', async () => {
    const path = 'delete me/gone soon.md';
    await client.uploadFile(path, textBuf('bye'));
    await client.deleteFile(path, '');
    await expect(client.downloadFile(path)).rejects.toMatchObject({ status: 404 });
    const files = await client.getFiles('');
    expect(files.map((f) => f.path)).not.toContain(path);
  });
});
