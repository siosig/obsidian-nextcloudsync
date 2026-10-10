import { NextcloudClient } from '../../../src/network/NextcloudClient';
import { Device } from './engineDevice';

export async function mirror(d: Device) {
  const plan = await d.engine.planRemoteMirror();
  const result = await d.engine.applyRemoteMirror(plan);
  return { plan, result };
}

export function expectQuiet(d: Device): void {
  const s = d.engine.getLastSessionSummary()!;
  expect({
    up: s.uploadedCount, down: s.downloadedCount, del: s.deletedCount,
    merged: s.mergedCount, conflicted: s.conflictedCount, err: s.errorCount,
  }).toEqual({ up: 0, down: 0, del: 0, merged: 0, conflicted: 0, err: 0 });
}

// path -> "etag|lastModified" for every remote file: proof that a sync wrote nothing to the server.
export async function remoteFingerprint(client: NextcloudClient): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await client.getFiles('')) out[f.path] = `${f.etag}|${f.lastModified}`;
  return out;
}
