import { FileLogger, DebugLogLevel } from '../../src/util/FileLogger';

function fakeAdapter() {
  const files: Record<string, string> = {};
  return {
    files,
    exists: jest.fn(async (p: string) => p in files),
    append: jest.fn(async (p: string, d: string) => { files[p] = (files[p] ?? '') + d; }),
    write: jest.fn(async (p: string, d: string) => { files[p] = d; }),
  };
}

function makeLogger(adapter: ReturnType<typeof fakeAdapter>, opts: {
  enabled?: boolean; level?: DebugLogLevel; host?: string; version?: string; path?: string;
} = {}) {
  return new FileLogger(
    adapter as never,
    () => opts.enabled ?? true,
    () => opts.level ?? 'debug',
    opts.version ?? '0.2.10',
    opts.host ?? 'desktop-a1b2c3',
    () => opts.path ?? 'logs/nextcloud-sync_debug_desktop-a1b2c3.md',
  );
}

describe('FileLogger level gating', () => {
  it('writes nothing when disabled', async () => {
    const a = fakeAdapter();
    await makeLogger(a, { enabled: false }).log('hi', 'error');
    expect(a.write).not.toHaveBeenCalled();
    expect(a.append).not.toHaveBeenCalled();
  });

  it('at level "error" writes only error calls', async () => {
    const a = fakeAdapter();
    const logger = makeLogger(a, { level: 'error' });
    await logger.log('an error', 'error');
    await logger.log('a debug', 'debug');
    await logger.log('a verbose', 'verbose');
    expect(a.files['logs/nextcloud-sync_debug_desktop-a1b2c3.md']).toContain('an error');
    expect(a.files['logs/nextcloud-sync_debug_desktop-a1b2c3.md']).not.toContain('a debug');
    expect(a.files['logs/nextcloud-sync_debug_desktop-a1b2c3.md']).not.toContain('a verbose');
  });

  it('at level "debug" writes error and debug, not verbose', async () => {
    const a = fakeAdapter();
    const logger = makeLogger(a, { level: 'debug' });
    await logger.log('msg-error', 'error');
    await logger.log('msg-debug', 'debug');
    await logger.log('msg-verbose', 'verbose');
    const content = a.files['logs/nextcloud-sync_debug_desktop-a1b2c3.md'];
    expect(content).toContain('msg-error');
    expect(content).toContain('msg-debug');
    expect(content).not.toContain('msg-verbose');
  });

  it('at level "verbose" writes everything', async () => {
    const a = fakeAdapter();
    const logger = makeLogger(a, { level: 'verbose' });
    await logger.log('msg-error', 'error');
    await logger.log('msg-debug', 'debug');
    await logger.log('msg-verbose', 'verbose');
    const content = a.files['logs/nextcloud-sync_debug_desktop-a1b2c3.md'];
    expect(content).toContain('msg-error');
    expect(content).toContain('msg-debug');
    expect(content).toContain('msg-verbose');
  });

  it('defaults the level to "debug" when omitted', async () => {
    const a = fakeAdapter();
    await makeLogger(a, { level: 'error' }).log('default-level');
    // default 'debug' is above the 'error' threshold → not written
    expect(a.append).not.toHaveBeenCalled();
    expect(a.write).not.toHaveBeenCalled();
  });

  it('records the host token and binary version, and appends to an existing file', async () => {
    const a = fakeAdapter();
    const logger = makeLogger(a, { level: 'debug', host: 'laptop', version: '1.2.3' });
    await logger.log('first');
    await logger.log('second');
    const content = a.files['logs/nextcloud-sync_debug_desktop-a1b2c3.md'];
    expect(content).toContain('[laptop]');
    expect(content).toContain('v1.2.3');
    expect(content).toContain('first');
    expect(content).toContain('second');
    expect(a.write).toHaveBeenCalledTimes(1); // created once
    expect(a.append).toHaveBeenCalledTimes(1); // appended once
  });
});
