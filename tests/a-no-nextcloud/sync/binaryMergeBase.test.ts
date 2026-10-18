import { MergeBaseRecorder } from '../../../src/sync/session/MergeBaseRecorder';
import { buildEngine, makeSummary, toBuf } from '../support/engineHarness';
import { RemoteFileInfo } from '../../../src/types';

describe('binary attachments do not allocate a text merge base', () => {
  it('does not decode a binary first-sync conflict, even when the decoder would exceed its string limit', async () => {
    const data = toBuf('arbitrary binary payload');
    const remote: RemoteFileInfo = { path: 'video.mov', fileId: '1', checksum: null,
      etag: 'e1', size: data.byteLength, lastModified: 1000 };
    const local = { stat: async () => ({ size: data.byteLength, mtime: 1000 }),
      readBinary: async () => data };
    const h = await buildEngine(local, { downloadFile: async () => data });
    const decode = jest.spyOn(TextDecoder.prototype, 'decode').mockImplementation(() => {
      throw new RangeError('Cannot create a string longer than the V8 limit');
    });
    try {
      await (h.engine as unknown as { handleConflict: (...a: unknown[]) => Promise<void> })
        .handleConflict('video.mov', undefined, remote, 'e1', 'etag', makeSummary());
      expect(decode).not.toHaveBeenCalled();
      expect(h.baseStore.set).not.toHaveBeenCalled();
      expect(h.stateDB.getFile('video.mov')).toMatchObject({ isConflicted: false });
    } finally { decode.mockRestore(); }
  });

  it('still decodes and stores Markdown and configured text file types', () => {
    const store = { set: jest.fn(), delete: jest.fn(), requestSave: jest.fn() };
    const recorder = new MergeBaseRecorder({ baseStore: store, autoMergeFileTypes: () => ['txt'] });
    // Keep the regression runnable against the old string-only recorder as well.
    const record = recorder.record.bind(recorder) as (path: string, body: string | ArrayBuffer) => void;
    record('note.md', toBuf('笔记正文'));
    record('data.txt', toBuf('text content'));
    expect(store.set.mock.calls).toEqual([['note.md', '笔记正文'], ['data.txt', 'text content']]);
    expect(store.requestSave).toHaveBeenCalledTimes(2);
  });
});
