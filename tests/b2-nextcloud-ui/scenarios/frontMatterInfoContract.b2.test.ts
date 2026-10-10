import { browser, expect } from '@wdio/globals';
import { FRONTMATTER_INFO_CORPUS } from '../../fixtures/frontMatterInfo';

describe('[SPEC:FMI-1] b-2 — the real getFrontMatterInfo matches the recorded corpus', function () {
  for (const { input, expected } of FRONTMATTER_INFO_CORPUS) {
    it(`matches for ${JSON.stringify(input)}`, async () => {
      const actual = await browser.executeObsidian(
        ({ obsidian }, text: string) => {
          const i = obsidian.getFrontMatterInfo(text);
          return { exists: i.exists, frontmatter: i.frontmatter, from: i.from, to: i.to, contentStart: i.contentStart };
        },
        input,
      );
      expect(actual).toEqual(expected);
    });
  }
});
