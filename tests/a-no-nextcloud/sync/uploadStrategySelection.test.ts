import { Platform } from 'obsidian';
import { SyncEngine } from '../../../src/sync/SyncEngine';
import { ChunkedUploadStrategy } from '../../../src/sync/upload/ChunkedUploadStrategy';
import { SimpleUploadStrategy } from '../../../src/sync/upload/SimpleUploadStrategy';
import { NextcloudFeatures } from '../../../src/types';

// Feature 033: chunked upload is always on (FIXED), the chunk threshold is platform-derived
// (50 desktop / 20 mobile), and file locking is always off — none read from settings anymore.

function makeEngine(features: Partial<NextcloudFeatures>) {
  const feats: NextcloudFeatures = {
    isNextcloud: true, version: '30', hasChecksums: true, hasFilesLocking: false,
    hasBulkUpload: false, syncToken: null, ...features,
  };
  const client = {
    lockFile: jest.fn(async () => 'lock-token'),
    unlockFile: jest.fn(async () => undefined),
  };
  const engine = new SyncEngine({
    settings: { maxFileSizeMB: 0 },
    webdavFactory: { createClient: jest.fn(async () => ({ client, features: feats })) },
    onFeatures: jest.fn(),
  } as never);
  return { engine, client };
}

async function ensureClient(engine: SyncEngine): Promise<void> {
  await (engine as unknown as { ensureClient(): Promise<unknown> }).ensureClient();
}
function strategyOf(engine: SyncEngine): unknown {
  return (engine as unknown as { uploadStrategy: unknown }).uploadStrategy;
}
function thresholdOf(strategy: unknown): number {
  return (strategy as { config: { uploadChunkThresholdMB: number } }).config.uploadChunkThresholdMB;
}

describe('[SPEC:FX-2] feature 033 — upload strategy is always chunked on Nextcloud', () => {
  afterEach(() => { Platform.isMobile = false; }); // restore desktop for other suites

  it('selects the chunked strategy when the server is Nextcloud (no setting consulted)', async () => {
    const { engine } = makeEngine({ isNextcloud: true });
    await ensureClient(engine);
    expect(strategyOf(engine)).toBeInstanceOf(ChunkedUploadStrategy);
  });

  it('falls back to the simple strategy on a non-Nextcloud server', async () => {
    const { engine } = makeEngine({ isNextcloud: false });
    await ensureClient(engine);
    expect(strategyOf(engine)).toBeInstanceOf(SimpleUploadStrategy);
  });
});

describe('[SPEC:FX-3] feature 033 — chunk threshold is platform-derived (desktop 50 / mobile 20)', () => {
  afterEach(() => { Platform.isMobile = false; });

  it('uses 50 MB on desktop', async () => {
    Platform.isMobile = false;
    const { engine } = makeEngine({ isNextcloud: true });
    await ensureClient(engine);
    expect(thresholdOf(strategyOf(engine))).toBe(50);
  });

  it('uses 20 MB on mobile', async () => {
    Platform.isMobile = true;
    const { engine } = makeEngine({ isNextcloud: true });
    await ensureClient(engine);
    expect(thresholdOf(strategyOf(engine))).toBe(20);
  });
});

describe('[SPEC:FX-4] feature 033 — file locking is always off (no LOCK issued)', () => {
  it('acquireLock returns null and never calls lockFile, even when the server supports locking', async () => {
    const { engine, client } = makeEngine({ hasFilesLocking: true });
    // ensureClient sets engine.features; acquire a lock for any path.
    await ensureClient(engine);
    const token = await (engine as unknown as { acquireLock(p: string): Promise<string | null> }).acquireLock('a.md');
    expect(token).toBeNull();
    expect(client.lockFile).not.toHaveBeenCalled();
  });
});
