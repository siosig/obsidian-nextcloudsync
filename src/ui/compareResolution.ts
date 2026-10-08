// Each ResolutionStrategy is one directional overwrite (push / pull); adding a resolution means adding a strategy
// to the list, with no change to CompareModal.

import { RemoteCompareResult } from '../types';
import { ConfirmOptions } from './ConfirmModal';

// Metrics of the two clean sides captured for a marker-conflicted path; "Latest modified" / "Biggest size" compare these
// instead of the marker content.
export interface CleanSideMetrics {
  localMtime: number;
  remoteMtime: number;
  localSize: number;
  remoteSize: number;
}

export interface CompareEngine {
  compareWithRemote(path: string): Promise<RemoteCompareResult>;
  pushLocalToRemote(path: string): Promise<void>;
  pullRemoteToLocal(path: string): Promise<void>;
  // Optional (absent in older fakes). When null or absent, force-resolution falls back to compare/push/pull on the current content.
  cleanSideMetrics?(path: string): CleanSideMetrics | null;
  applyCleanRemote?(path: string): Promise<void>;
  applyCleanLocal?(path: string): Promise<void>;
}

export interface ResolutionStrategy {
  readonly id: 'push' | 'pull';
  readonly name: string;
  readonly buttonLabel: string;
  isApplicable(result: RemoteCompareResult): boolean;
  confirmOptions(path: string): ConfirmOptions;
  readonly successNotice: string;
  execute(engine: CompareEngine, path: string): Promise<void>;
}

const pushStrategy: ResolutionStrategy = {
  id: 'push',
  name: 'Push',
  buttonLabel: 'Push (overwrite remote)',
  isApplicable: (r) => r.localExists,
  confirmOptions: (path) => ({
    title: 'Overwrite remote?',
    message: `This overwrites the remote copy of "${path}" with your local version. This cannot be undone.`,
    cta: 'Push',
    destructive: true,
  }),
  successNotice: 'Pushed local to remote.',
  execute: (engine, path) => engine.pushLocalToRemote(path),
};

const pullStrategy: ResolutionStrategy = {
  id: 'pull',
  name: 'Pull',
  buttonLabel: 'Pull (overwrite local)',
  isApplicable: (r) => r.remoteExists,
  confirmOptions: (path) => ({
    title: 'Overwrite local?',
    message: `This overwrites your local copy of "${path}" with the remote version. This cannot be undone.`,
    cta: 'Pull',
    destructive: true,
  }),
  successNotice: 'Pulled remote to local.',
  execute: (engine, path) => engine.pullRemoteToLocal(path),
};

export const RESOLUTION_STRATEGIES: readonly ResolutionStrategy[] = [pushStrategy, pullStrategy];
