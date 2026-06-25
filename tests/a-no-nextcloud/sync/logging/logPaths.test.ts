import { joinLogPath, syncLogPath, debugLogPath, isActiveOwnLog } from '../../../../src/util/logPaths';

describe('logPaths — log files use the .txt extension', () => {
  // The logs are plain text (not Markdown); a .md extension makes editors
  // render them as Markdown and garble the output. They must be .txt.
  it('sync-log path ends with .txt', () => {
    expect(syncLogPath('_logs', 'desktop-abc')).toBe('_logs/nextcloud-sync_sync_desktop-abc.txt');
  });

  it('debug-log path ends with .txt', () => {
    expect(debugLogPath('_logs', 'desktop-abc')).toBe('_logs/nextcloud-sync_debug_desktop-abc.txt');
  });

  it('blank logsFolder puts the file at the vault root', () => {
    expect(syncLogPath('', 'ios')).toBe('nextcloud-sync_sync_ios.txt');
    expect(debugLogPath('', 'ios')).toBe('nextcloud-sync_debug_ios.txt');
  });

  it('joinLogPath strips trailing slashes', () => {
    expect(joinLogPath('_logs/', 'x.txt')).toBe('_logs/x.txt');
  });
});

describe('[SPEC:LOG-1] isActiveOwnLog — exclude a log only while THIS device is writing it', () => {
  const HOST = 'desktop-plugintest';
  // Feature 028: the per-log toggles are unified into a single loggingEnabled flag.
  const base = { logsFolder: '_logs', host: HOST, loggingEnabled: true };
  const debugP = debugLogPath('_logs', HOST);
  const syncP = syncLogPath('_logs', HOST);

  it('excludes the debug log while logging is ON', () => {
    expect(isActiveOwnLog(debugP, { ...base, loggingEnabled: true })).toBe(true);
    expect(isActiveOwnLog(debugP, { ...base, loggingEnabled: false })).toBe(false); // OFF → syncable
  });

  it('excludes the sync log while logging is ON', () => {
    expect(isActiveOwnLog(syncP, { ...base, loggingEnabled: true })).toBe(true);
    expect(isActiveOwnLog(syncP, { ...base, loggingEnabled: false })).toBe(false); // OFF → syncable
  });

  it('excludes both logs together under the unified toggle', () => {
    const on = { ...base, loggingEnabled: true };
    expect(isActiveOwnLog(debugP, on)).toBe(true);
    expect(isActiveOwnLog(syncP, on)).toBe(true);
  });

  it("does not exclude another device's log (different host) — it stays syncable", () => {
    const other = debugLogPath('_logs', 'desktop-other');
    expect(isActiveOwnLog(other, base)).toBe(false);
  });

  it('does not exclude ordinary vault files', () => {
    expect(isActiveOwnLog('Notes/a.md', base)).toBe(false);
    expect(isActiveOwnLog('_logs/some-other-file.txt', base)).toBe(false);
  });

  it('works with a blank logsFolder (logs at vault root)', () => {
    const root = { ...base, logsFolder: '' };
    expect(isActiveOwnLog(`nextcloud-sync_debug_${HOST}.txt`, root)).toBe(true);
    expect(isActiveOwnLog(`nextcloud-sync_sync_${HOST}.txt`, root)).toBe(true);
  });
});
