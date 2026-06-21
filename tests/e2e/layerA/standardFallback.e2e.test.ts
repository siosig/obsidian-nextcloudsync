// Layer A — standard WebDAV fallback (ST-1) per report/mock_test.md §3.K.
// StandardWebDAVClient must reject Nextcloud-only features with FeatureUnsupportedError.
import { StandardWebDAVClient } from '../../../src/network/StandardWebDAVClient';
import { FeatureUnsupportedError, FileVersion } from '../../../src/types';
import { describeLive } from '../support/env';
import { makeSettings } from '../support/clientFactory';
import { IsolatedWorkspace, makeIsolatedWorkspace } from '../support/isolation';

describeLive('Layer A — standard WebDAV fallback (ST)', (getEnv) => {
  let ws: IsolatedWorkspace;
  let std: StandardWebDAVClient;

  beforeAll(() => {
    const env = getEnv();
    ws = makeIsolatedWorkspace(env.syncFolder);
    std = new StandardWebDAVClient(makeSettings(env), env.appPassword, ws.remoteBase);
  });

  it('ST-1 Nextcloud-only features throw FeatureUnsupportedError', async () => {
    const fakeVersion: FileVersion = { versionId: '1', href: '', lastModified: 0, size: 0 };
    await expect(std.listVersions('1')).rejects.toBeInstanceOf(FeatureUnsupportedError);
    await expect(std.getVersionContent(fakeVersion, '1')).rejects.toBeInstanceOf(FeatureUnsupportedError);
    await expect(std.restoreVersion(fakeVersion, '1')).rejects.toBeInstanceOf(FeatureUnsupportedError);
    await expect(std.uploadChunked('x.md', new ArrayBuffer(1), 1)).rejects.toBeInstanceOf(FeatureUnsupportedError);
    await expect(std.lockFile('x.md')).rejects.toBeInstanceOf(FeatureUnsupportedError);
  });
});
