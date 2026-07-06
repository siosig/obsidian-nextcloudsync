import { joinLogPath, debugLogPath, isActiveOwnLog } from '../../../../src/util/logPaths';

describe('logPaths — the single per-device log file uses the .txt extension', () => {
  // The log is plain text (not Markdown); a .md extension makes editors render it as Markdown and
  // garble the output. Feature 052 folded the old two files into one `nextcloud-debug_<host>.txt`.
  it('debug-log path is nextcloud-debug_<host>.txt', () => {
    expect(debugLogPath('_logs', 'desktop-abc')).toBe('_logs/nextcloud-debug_desktop-abc.txt');
  });

  it('blank logsFolder puts the file at the vault root', () => {
    expect(debugLogPath('', 'ios')).toBe('nextcloud-debug_ios.txt');
  });

  it('joinLogPath strips trailing slashes', () => {
    expect(joinLogPath('_logs/', 'x.txt')).toBe('_logs/x.txt');
  });
});

describe('[SPEC:LOG-1] isActiveOwnLog — exclude the log only while THIS device is writing it', () => {
  const HOST = 'desktop-plugintest';
  // Feature 028: the per-log toggles are unified into a single loggingEnabled flag.
  const base = { logsFolder: '_logs', host: HOST, loggingEnabled: true };
  const debugP = debugLogPath('_logs', HOST);

  it('excludes this device\'s log while logging is ON, syncable while OFF', () => {
    expect(isActiveOwnLog(debugP, { ...base, loggingEnabled: true })).toBe(true);
    expect(isActiveOwnLog(debugP, { ...base, loggingEnabled: false })).toBe(false); // OFF → syncable
  });

  it("does not exclude another device's log (different host) — it stays syncable", () => {
    const other = debugLogPath('_logs', 'desktop-other');
    expect(isActiveOwnLog(other, base)).toBe(false);
  });

  it('does not exclude ordinary vault files', () => {
    expect(isActiveOwnLog('Notes/a.md', base)).toBe(false);
    expect(isActiveOwnLog('_logs/some-other-file.txt', base)).toBe(false);
    // The old sync-log name is now an ordinary file (the writer was removed) → syncable.
    expect(isActiveOwnLog(`_logs/nextcloud-sync_sync_${HOST}.txt`, base)).toBe(false);
  });

  it('works with a blank logsFolder (log at vault root)', () => {
    const root = { ...base, logsFolder: '' };
    expect(isActiveOwnLog(`nextcloud-debug_${HOST}.txt`, root)).toBe(true);
  });
});
