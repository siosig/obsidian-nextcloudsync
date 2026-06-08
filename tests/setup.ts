// Obsidian runs in Electron, where `window` exists. The jest `node` test environment has no
// `window`, but the source uses `window.setTimeout` / `clearTimeout` / `setInterval` (required by
// the obsidianmd "prefer-window-timers" rule for popout-window compatibility). Alias window onto
// the Node global so those timer calls resolve in tests.
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
