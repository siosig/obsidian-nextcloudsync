import { Setting, setTooltip } from 'obsidian';

/**
 * Create a settings row whose `setTooltip()` labels the whole row instead of only
 * the name.
 *
 * Why: Obsidian's `Setting.setTooltip()` sets `aria-label` on `nameEl` alone (the
 * short bold title). Every row here also has a long, always-visible description,
 * which is the large area users actually hover to read — but it has no
 * `aria-label`, so Obsidian's hover tooltip never appears there and the tooltips
 * look broken. The canonical UI mock (specs/main/desktop/settings.html) carries
 * the tooltip on the whole `.setting-item` row, so we do the same.
 *
 * This keeps every `new Setting(...).setName(...).setDesc(...).setTooltip(...)`
 * chain intact: only the constructor call changes. Inner controls (buttons,
 * toggles, inputs) keep their own `aria-label`, and Obsidian resolves the nearest
 * labelled ancestor on hover, so there is no conflict.
 */
export function makeSetting(containerEl: HTMLElement): Setting {
  const setting = new Setting(containerEl);
  setting.setTooltip = (tooltip: string) => {
    setTooltip(setting.settingEl, tooltip);
    return setting;
  };
  return setting;
}
