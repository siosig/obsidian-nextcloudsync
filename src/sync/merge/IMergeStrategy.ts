import { MergeResult } from '../../types';

export interface IMergeStrategy {
  merge(base: string, local: string, remote: string): MergeResult;
}
