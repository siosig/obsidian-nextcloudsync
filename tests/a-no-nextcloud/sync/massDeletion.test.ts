import { massDeleteLimit, isMassDeletionGuarded, MASS_DELETE_MIN } from '../../../src/util/limits';

// [SPEC:DEL-3] docs/spec.md §8 — mass-delete circuit breaker. A full-scan reconciliation may delete
// locally at most max(20, floor(20% of tracked)) "remotely absent" files; beyond that it assumes a
// partial/failed remote listing and refuses, to avoid wiping the vault. The threshold previously
// lived as an inline `Math.max(20, Math.floor(tracked * 0.2))` in SyncEngine with no a-layer test
// (its only b-1 test is an it.skip stub); extracted here as a pure helper so the contract is verified.

describe('[SPEC:DEL-3] mass-delete circuit breaker threshold', () => {
  describe('massDeleteLimit', () => {
    it('floors at 20 for small/empty tracked sets (20% would be lower)', () => {
      expect(massDeleteLimit(0)).toBe(MASS_DELETE_MIN);
      expect(massDeleteLimit(1)).toBe(20);
      expect(massDeleteLimit(99)).toBe(20); // floor(19.8)=19 < 20 → clamped to 20
      expect(massDeleteLimit(100)).toBe(20); // floor(20)=20, tie → 20
    });

    it('scales to 20% of the tracked set once that exceeds 20', () => {
      expect(massDeleteLimit(101)).toBe(20); // floor(20.2)=20
      expect(massDeleteLimit(105)).toBe(21); // floor(21)=21 > 20
      expect(massDeleteLimit(1000)).toBe(200);
    });
  });

  describe('isMassDeletionGuarded', () => {
    it('does NOT guard when candidates are within the limit', () => {
      expect(isMassDeletionGuarded(20, 50)).toBe(false); // limit 20, 20 is not > 20
      expect(isMassDeletionGuarded(200, 1000)).toBe(false); // limit 200, exactly at cap
      expect(isMassDeletionGuarded(0, 0)).toBe(false);
    });

    it('guards (refuses bulk local deletion) when candidates exceed the limit', () => {
      expect(isMassDeletionGuarded(21, 50)).toBe(true); // limit 20
      expect(isMassDeletionGuarded(201, 1000)).toBe(true); // limit 200
      // A near-total wipe of a large vault is always guarded.
      expect(isMassDeletionGuarded(900, 1000)).toBe(true);
    });
  });
});
