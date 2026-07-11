// Repro for GitHub issue #15: "Auto sync closes the currently open note after synchronization".
//
// A note is open in the active leaf; a remote-side change (simulated via the plugin's own
// already-authenticated WebDAV client, standing in for another device's edit) is pulled down by
// sync-now — the same code path a periodic background sync takes. LocalAdapter.atomicWrite /
// atomicWriteBinary (src/data/LocalAdapter.ts) apply that change as write-tmp -> remove(target) ->
// rename(tmp, target): a physical delete+recreate of the file Obsidian is displaying. Obsidian
// detaches the view on the delete event, leaving an empty pane in the same leaf — reproduced
// 2026-07-11 against a live instance (leaf survives, but its view drops to viewType "empty" with
// no file). Expected to fail until atomicWrite avoids delete+recreate for a currently open file.
import { browser, expect } from '@wdio/globals';
import { requireUiEnv } from '../support/env';

const ui = requireUiEnv();
const NOTE_PATH = 'b2-issue15-active-leaf.md';
const PASSWORD_SECRET_ID = 'b2-issue15-active-leaf-secret';
const ORIGINAL_CONTENT = 'original content (issue #15 repro)';
const REMOTE_EDIT_CONTENT = 'remote edit content (issue #15 repro)';

describe('[issue-15][SPEC:OL-1] active leaf survives a sync that updates the open note', function () {
  it('the open note stays open after sync-now applies a remote-side change', async function () {
    if (!ui.ok) this.skip();

    await browser.executeObsidian(
      async ({ app }, server: string, user: string, password: string, secretId: string, path: string, content: string) => {
        const p = (app as any).plugins.plugins['nextcloud-sync'];
        p.settings.serverUrl = server;
        p.settings.username = user;
        p.settings.passwordSecretId = secretId;
        app.secretStorage.setSecret(secretId, password);
        await p.saveData?.(p.settings);

        const existing = app.vault.getAbstractFileByPath(path);
        if (existing) await app.vault.delete(existing);
        await app.vault.create(path, content);

        // Establish the baseline: push the note to the server and record it as synced.
        await p.runSyncNow();
      },
      ui.values.NEXTCLOUD_SERVER_URL,
      ui.values.NEXTCLOUD_USER,
      ui.values.NEXTCLOUD_PASSWORD,
      PASSWORD_SECRET_ID,
      NOTE_PATH,
      ORIGINAL_CONTENT,
    );

    const leafId = await browser.executeObsidian(async ({ app }, path: string) => {
      const file = app.vault.getAbstractFileByPath(path);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      return app.workspace.activeLeaf?.id ?? null;
    }, NOTE_PATH);
    expect(leafId).not.toBeNull();

    // Simulate another device changing the file on the server, then pull it down with sync-now.
    await browser.executeObsidian(
      async ({ app }, path: string, content: string) => {
        const p = (app as any).plugins.plugins['nextcloud-sync'];
        const client = p.syncEngine.client;
        const data = new TextEncoder().encode(content).buffer;
        await client.uploadFile(path, data, Date.now());
        await p.runSyncNow();
      },
      NOTE_PATH,
      REMOTE_EDIT_CONTENT,
    );

    const after = await browser.executeObsidian(async ({ app }, id: string, path: string) => {
      const leaf = app.workspace.getLeafById(id);
      const file = leaf?.view && (leaf.view as any).file;
      return {
        leafSurvived: !!leaf,
        stillShowingNote: file?.path === path,
        editorContent: (leaf?.view as any)?.editor?.getValue?.() ?? null,
      };
    }, leafId as string, NOTE_PATH);

    // The bug: sync's delete+recreate of the open file detaches the leaf's view (empty pane).
    expect(after.leafSurvived).toBe(true);
    expect(after.stillShowingNote).toBe(true);
    expect(after.editorContent).toBe(REMOTE_EDIT_CONTENT);
  });
});
