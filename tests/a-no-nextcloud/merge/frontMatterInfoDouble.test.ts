import { getFrontMatterInfo } from 'obsidian';
import { FRONTMATTER_INFO_CORPUS } from '../../fixtures/frontMatterInfo';

describe('[SPEC:FMI-2] the getFrontMatterInfo test double matches the recorded corpus', () => {
  it.each(FRONTMATTER_INFO_CORPUS.map(({ input, expected }) => [JSON.stringify(input), input, expected] as const))(
    'matches for %s',
    (_label, input, expected) => {
      expect(getFrontMatterInfo(input)).toEqual(expected);
    },
  );
});
