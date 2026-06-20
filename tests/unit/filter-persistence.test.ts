import { serializeFilter, deserializeFilter, makeDefaultFilterState, ALL_FILTER_OPS } from '../../src/ui/statusFilter';

describe('filter persistence (US4)', () => {
  it('deserializes undefined/null/non-array to the all-on default', () => {
    expect([...deserializeFilter(undefined).checked].sort()).toEqual([...ALL_FILTER_OPS].sort());
    expect([...deserializeFilter(null).checked].sort()).toEqual([...ALL_FILTER_OPS].sort());
    expect([...deserializeFilter('garbage').checked].sort()).toEqual([...ALL_FILTER_OPS].sort());
  });

  it('drops unknown keys but keeps valid ones', () => {
    const state = deserializeFilter(['uploaded', 'bogus', 'error']);
    expect([...state.checked].sort()).toEqual(['error', 'uploaded']);
  });

  it('treats an explicit empty array as all-unchecked (distinct from undefined)', () => {
    expect([...deserializeFilter([]).checked]).toEqual([]);
  });

  it('round-trips serialize → deserialize for valid keys', () => {
    const state = makeDefaultFilterState();
    state.checked.delete('uploaded');
    const restored = deserializeFilter(serializeFilter(state));
    expect([...restored.checked].sort()).toEqual([...state.checked].sort());
    expect(restored.checked.has('uploaded')).toBe(false);
  });

  it('serializeFilter yields a JSON-friendly array', () => {
    const arr = serializeFilter(makeDefaultFilterState());
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.sort()).toEqual([...ALL_FILTER_OPS].sort());
  });
});
