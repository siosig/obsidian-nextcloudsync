import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SLIDER_LIMITS, SliderLimit } from '../../../src/settings/sliderLimits';
import { DEFAULT_SETTINGS } from '../../../src/types';

// Enumerated via require (not a namespace import) to avoid the tslib __importStar
// helper, which this project does not bundle.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sliderLimitsModule = require('../../../src/settings/sliderLimits') as Record<string, unknown>;

// Feature 034: the four numeric settings sliders get new ranges/steps. SLIDER_LIMITS
// is the single source of truth; SettingTab, the mockup (settings.html) and spec.md
// §15.1 all mirror it. A value sits "on the grid" when it is min + k*step within bounds.
const onGrid = (value: number, { min, max, step }: SliderLimit): boolean =>
  value >= min && value <= max && (value - min) % step === 0;

// Expected limits straight from contracts/slider-limits.md (kept literal so the test
// fails loudly if the constant drifts, rather than re-deriving from the constant).
const EXPECTED: Record<string, SliderLimit> = {
  startupSyncDelay: { min: 0, max: 15, step: 1 },
  networkTimeout: { min: 15, max: 120, step: 15 },
  networkConcurrency: { min: 1, max: 64, step: 4 },
  maxFileSize: { min: 0, max: 2048, step: 16 },
};

describe('[SPEC:SLD-1] slider limits match the contract', () => {
  for (const [key, want] of Object.entries(EXPECTED)) {
    it(`${key} is ${want.min}/${want.max}/${want.step}`, () => {
      expect(SLIDER_LIMITS[key as keyof typeof SLIDER_LIMITS]).toEqual(want);
    });
  }

  it('exposes exactly the four target sliders (no extras)', () => {
    expect(Object.keys(SLIDER_LIMITS).sort()).toEqual(
      ['maxFileSize', 'networkConcurrency', 'networkTimeout', 'startupSyncDelay'],
    );
  });
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
});

describe('[SPEC:SLD-4] off-grid defaults are known and tolerated (non-destructive)', () => {
  // These do NOT sit on the new grid. FR-007 keeps them as-is until the user moves
  // the slider; this test pins the fact so a future grid change is a conscious choice.
  it('networkConcurrency default 16 is off the 1/64/4 grid', () => {
    expect(onGrid(DEFAULT_SETTINGS.networkConcurrency, SLIDER_LIMITS.networkConcurrency)).toBe(false);
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
    ['Network timeout (seconds)', SLIDER_LIMITS.networkTimeout],
    ['Network concurrency', SLIDER_LIMITS.networkConcurrency],
    ['Maximum file size (MB)', SLIDER_LIMITS.maxFileSize],
  ];

  for (const [label, want] of ROWS) {
    it(`${label} mockup slider = ${want.min}/${want.max}/${want.step}`, () => {
      expect(sliderAfter(label)).toEqual({ min: want.min, max: want.max, step: want.step });
    });
  }

  it('Sync interval mockup slider is unchanged (out of scope: 0/60/1)', () => {
    expect(sliderAfter('Sync interval (minutes)')).toEqual({ min: 0, max: 60, step: 1 });
  });
});
