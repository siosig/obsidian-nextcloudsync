// Regression for the "tooltips don't show" bug (spec 020). Obsidian's
// Setting.setTooltip labels only the narrow name element (verified against the
// shipped obsidian.asar 1.12.7: it sets aria-label on this.nameEl). Hovering the
// large always-visible description — where users actually read — then shows
// nothing, so tooltips appear missing. The canonical mock
// (specs/main/desktop/settings.html) carries the tooltip on the whole .setting-item
// row, so makeSetting() must label settingEl, not nameEl.
import { Setting, FakeEl } from '../support/obsidian';
import { makeSetting } from '../../../src/settings/settingFactory';

const container = {} as unknown as HTMLElement;
const ariaOf = (el: FakeEl): string | null => el.getAttribute('aria-label');

describe('[SPEC:FR-001] settings tooltip is reachable on the whole row', () => {
  it('[SPEC:FR-005] makeSetting().setTooltip labels the whole row (settingEl), not just the name', () => {
    const setting = makeSetting(container).setName('Server URL').setTooltip('full WebDAV endpoint');

    // The fix: the row carries the tooltip, so hovering the description works.
    expect(ariaOf((setting as unknown as { settingEl: FakeEl }).settingEl)).toBe('full WebDAV endpoint');
    // And it is not left only on the narrow name element.
    expect(ariaOf((setting as unknown as { nameEl: FakeEl }).nameEl)).toBeNull();
  });

  it('characterizes the bug: a plain Setting labels only the name (nameEl), not the row', () => {
    const setting = new Setting(container).setName('Server URL').setTooltip('full WebDAV endpoint');

    expect(ariaOf(setting.nameEl)).toBe('full WebDAV endpoint');
    expect(ariaOf(setting.settingEl)).toBeNull();
  });
});
