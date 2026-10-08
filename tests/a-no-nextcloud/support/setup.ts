// Obsidian runs in Electron, where `window` exists; jest's `node` environment has none. Alias it onto
// the Node global so src's `window.setTimeout` / `clearTimeout` / `setInterval` calls (required by the
// obsidianmd prefer-window-timers rule) resolve.
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
