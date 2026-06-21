import { ReconcileTextStrategy } from '../../../src/sync/merge/ReconcileTextStrategy';

// reconcile-text's reconcile() returns a TextWithCursors object ({ text, cursors }).
// Regression: the strategy previously stored the whole object, corrupting merged content to "[object Object]".
jest.mock('reconcile-text', () => ({
  reconcile: (_b: string, local: string, _r: string) => ({ text: `MERGED:${local}`, cursors: [] }),
}));

describe('ReconcileTextStrategy', () => {
  it('extracts the merged string from the reconcile() result object (.text)', () => {
    const result = new ReconcileTextStrategy().merge('', 'hello', 'hello');
    expect(result.success).toBe(true);
    expect(typeof result.mergedContent).toBe('string');
    expect(result.mergedContent).toBe('MERGED:hello');
    // Must never leak the object's stringification into content.
    expect(result.mergedContent).not.toContain('[object Object]');
  });
});
