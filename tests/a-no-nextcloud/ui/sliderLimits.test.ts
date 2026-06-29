import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SLIDER_LIMITS, SliderLimit } from '../../../src/settings/sliderLimits';
import { DEFAULT_SETTINGS } from '../../../src/types';

// Enumerated via require (not a namespace import) to avoid the tslib __importStar
// helper, which this project does not bundle.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sliderLimitsModule = require('../../../src/settings/sliderLimits') as Record<string, unknown>;

// Feature 034 (+ 034-rev): the numeric settings sliders get new ranges/steps. SLIDER_LIMITS
// is the single source of truth; SettingTab, the mockup (settings.html) and spec.md §15.1 all
// mirror it. A value sits "on the grid" when it is min + k*step within bounds.
const onGrid = (value: number, { min, max, step }: SliderLimit): boolean =>
  value >= min && value <= max && (value - min) % step === 0;

// Expected limits straight from spec.md §15.1-slider (kept literal so the test fails loudly
// if the constant drifts, rather than re-deriving from the constant). 034-rev: startup 0/10/1
// (0 = off), syncInterval added at 0/60/4 (0 = manual only), networkConcurrency 0/60/4 (0 = 1).
const EXPECTED: Record<string, SliderLimit> = {
  startupSyncDelay: { min: 0, max: 10, step: 1 },
  syncInterval: { min: 0, max: 60, step: 4 },
  networkTimeout: { min: 15, max: 120, step: 15 },
  networkConcurrency: { min: 0, max: 60, step: 4 },
  maxFileSize: { min: 0, max: 2048, step: 16 },
};

describe('[SPEC:SLD-1] slider limits match the contract', () => {
  for (const [key, want] of Object.entries(EXPECTED)) {
    it(`${key} is ${want.min}/${want.max}/${want.step}`, () => {
      expect(SLIDER_LIMITS[key as keyof typeof SLIDER_LIMITS]).toEqual(want);
    });
  }

  it('exposes exactly the five target sliders (no extras)', () => {
    expect(Object.keys(SLIDER_LIMITS).sort()).toEqual(
      ['maxFileSize', 'networkConcurrency', 'networkTimeout', 'startupSyncDelay', 'syncInterval'],
    );
  });
});

describe('[SPEC:SNI-11] feature 036 leaves the existing five sliders unchanged', () => {
  // Adding the numeric input + chunk threshold must not alter any existing slider's range.
  const UNCHANGED: Array<keyof typeof SLIDER_LIMITS> = [
    'startupSyncDelay', 'syncInterval', 'networkTimeout', 'networkConcurrency', 'maxFileSize',
  ];
  for (const key of UNCHANGED) {
    it(`${key} range/step is unchanged`, () => {
      expect(SLIDER_LIMITS[key]).toEqual(EXPECTED[key]);
    });
  }
});

describe('[SPEC:SLD-2] max is a whole multiple of step (no fractional final step)', () => {
  for (const [key, limit] of Object.entries(SLIDER_LIMITS)) {
    it(`${key}: max % step === 0`, () => {
      expect(limit.max % limit.step).toBe(0);
      expect(limit.min).toBeGreaterThanOrEqual(0);
      expect(limit.max).toBeGreaterThan(limit.min);
      expect(limit.step).toBeGreaterThan(0);
    });
  }
});

describe('[SPEC:SLD-3] on-grid defaults are reachable on their slider', () => {
  it('startupSyncDelaySeconds default is on the grid', () => {
    expect(onGrid(DEFAULT_SETTINGS.startupSyncDelaySeconds, SLIDER_LIMITS.startupSyncDelay)).toBe(true);
  });
  it('networkTimeoutSeconds default is on the grid (min=15 chosen so 30 is reachable)', () => {
    expect(onGrid(DEFAULT_SETTINGS.networkTimeoutSeconds, SLIDER_LIMITS.networkTimeout)).toBe(true);
  });
  it('maxFileSizeMB desktop default (0 = unlimited) is on the grid', () => {
    expect(onGrid(DEFAULT_SETTINGS.maxFileSizeMB, SLIDER_LIMITS.maxFileSize)).toBe(true);
  });
  it('networkConcurrency default 16 is on the new 0/60/4 grid (16 = 4×4)', () => {
    expect(onGrid(DEFAULT_SETTINGS.networkConcurrency, SLIDER_LIMITS.networkConcurrency)).toBe(true);
  });
});

describe('[SPEC:SLD-4] off-grid defaults are known and tolerated (non-destructive)', () => {
  // These do NOT sit on the new grid. FR-007 keeps them as-is until the user moves
  // the slider; this test pins the fact so a future grid change is a conscious choice.
  it('syncIntervalMinutes default 15 is off the 0/60/4 grid', () => {
    expect(onGrid(DEFAULT_SETTINGS.syncIntervalMinutes, SLIDER_LIMITS.syncInterval)).toBe(false);
  });
  it('a RAM-derived networkConcurrency of 3 is off the 0/60/4 grid', () => {
    expect(onGrid(3, SLIDER_LIMITS.networkConcurrency)).toBe(false);
  });
  it('mobile maxFileSizeMB=20 is off the 0/2048/16 grid', () => {
    expect(onGrid(20, SLIDER_LIMITS.maxFileSize)).toBe(false);
  });
});

describe('[SPEC:SLD-5] sliderLimits is a pure constant module (no value-mutating logic)', () => {
  it('exports only data — no functions that could rewrite stored values', () => {
    for (const [name, value] of Object.entries(sliderLimitsModule)) {
      // Type aliases/interfaces erase at runtime; only SLIDER_LIMITS remains as a value.
      expect(typeof value).not.toBe('function');
      expect(name).toBeTruthy();
    }
  });
  it('SLIDER_LIMITS entries hold plain numbers only', () => {
    for (const limit of Object.values(SLIDER_LIMITS)) {
      for (const n of Object.values(limit)) {
        expect(typeof n).toBe('number');
      }
    }
  });
});

describe('[SPEC:SLD-6] the desktop mockup mirrors SLIDER_LIMITS', () => {
  const html = readFileSync(
    resolve(process.cwd(), 'specs/main/desktop/settings.html'),
    'utf-8',
  );

  // Find the first range <input> after the given comment label, and read its attrs.
  const sliderAfter = (label: string): { min: number; max: number; step: number } => {
    const anchor = html.indexOf(`<!-- ${label} -->`);
    expect(anchor).toBeGreaterThanOrEqual(0);
    const tag = html.slice(anchor).match(/<input type="range"[^>]*>/);
    expect(tag).not.toBeNull();
    const attr = (name: string): number => {
      const m = (tag as RegExpMatchArray)[0].match(new RegExp(`${name}="(\\d+)"`));
      expect(m).not.toBeNull();
      return Number((m as RegExpMatchArray)[1]);
    };
    return { min: attr('min'), max: attr('max'), step: attr('step') };
  };

  const ROWS: Array<[string, SliderLimit]> = [
    ['Startup sync delay (seconds)', SLIDER_LIMITS.startupSyncDelay],
    ['Sync interval (minutes)', SLIDER_LIMITS.syncInterval],
    ['Network timeout (seconds)', SLIDER_LIMITS.networkTimeout],
    ['Network concurrency', SLIDER_LIMITS.networkConcurrency],
    ['Maximum file size (MB)', SLIDER_LIMITS.maxFileSize],
  ];

  for (const [label, want] of ROWS) {
    it(`${label} mockup slider = ${want.min}/${want.max}/${want.step}`, () => {
      expect(sliderAfter(label)).toEqual({ min: want.min, max: want.max, step: want.step });
    });
  }

  it('the former "Sync on startup" toggle row is gone from the mockup (folded into the slider)', () => {
    expect(html.includes('<!-- Sync on startup -->')).toBe(false);
    expect(html.includes('>Sync on startup<')).toBe(false);
  });
});

describe('[SPEC:SLD-8] networkConcurrency exposes 0 but consumers floor it to an effective 1', () => {
  // The slider min is 0 (for a clean 0/4/…/60 grid), yet a concurrency of 0 must never mean
  // "no requests". The two SyncEngine consumers wrap the setting in Math.max(1, …); this test
  // pins that contract at the source so lowering the slider to 0 stays equivalent to 1.
  const src = readFileSync(resolve(process.cwd(), 'src/sync/SyncEngine.ts'), 'utf-8');
  it('SLIDER_LIMITS.networkConcurrency.min is 0', () => {
    expect(SLIDER_LIMITS.networkConcurrency.min).toBe(0);
  });
  it('every SyncEngine read of networkConcurrency is floored with Math.max(1, …)', () => {
    const reads = src.match(/settings\.networkConcurrency/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    const floored = src.match(/Math\.max\(1,\s*this\.opts\.settings\.networkConcurrency\)/g) ?? [];
    expect(floored.length).toBe(reads.length);
  });
});
