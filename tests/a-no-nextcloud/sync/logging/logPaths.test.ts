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

describe('isActiveOwnLog — exclude a log only while THIS device is writing it', () => {
  const HOST = 'desktop-plugintest';
  const base = { logsFolder: '_logs', host: HOST, debugLogEnabled: true, syncLogEnabled: true };
  const debugP = debugLogPath('_logs', HOST);
  const syncP = syncLogPath('_logs', HOST);

  it('excludes the debug log only when debug logging is ON', () => {
    expect(isActiveOwnLog(debugP, { ...base, debugLogEnabled: true })).toBe(true);
    expect(isActiveOwnLog(debugP, { ...base, debugLogEnabled: false })).toBe(false); // OFF → syncable
  });

  it('excludes the sync log only when sync logging is ON', () => {
    expect(isActiveOwnLog(syncP, { ...base, syncLogEnabled: true })).toBe(true);
    expect(isActiveOwnLog(syncP, { ...base, syncLogEnabled: false })).toBe(false); // OFF → syncable
  });

  it('the two toggles are independent', () => {
    const onlyDebug = { ...base, debugLogEnabled: true, syncLogEnabled: false };
    expect(isActiveOwnLog(debugP, onlyDebug)).toBe(true);
    expect(isActiveOwnLog(syncP, onlyDebug)).toBe(false);
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
