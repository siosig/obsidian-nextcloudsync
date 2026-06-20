// Strategy pattern for the compare popup's resolution actions. Each ResolutionStrategy encapsulates
// one directional overwrite (push / pull): when it applies, its confirmation copy, and how to execute
// it. Adding a new resolution (e.g. a normal sync) is a matter of adding a strategy to the list —
// the CompareModal iterates them and needs no change (OCP). The modal depends on the CompareEngine
// abstraction rather than the concrete SyncEngine (DIP).

import { RemoteCompareResult } from '../types';
import { ConfirmOptions } from './ConfirmModal';

/** The slice of SyncEngine that the compare popup and its strategies need (kept narrow for DIP/testability). */
export interface CompareEngine {
  compareWithRemote(path: string): Promise<RemoteCompareResult>;
  pushLocalToRemote(path: string): Promise<void>;
  pullRemoteToLocal(path: string): Promise<void>;
}

/** One directional resolution the user can choose from the compare popup. */
export interface ResolutionStrategy {
  readonly id: 'push' | 'pull';
  /** Short verb for notices, e.g. "Push" / "Pull". */
  readonly name: string;
  readonly buttonLabel: string;
  /** Whether this action applies to the current comparison (push needs a local file, pull a remote one). */
  isApplicable(result: RemoteCompareResult): boolean;
  /** Confirmation dialog shown before the destructive overwrite. */
  confirmOptions(path: string): ConfirmOptions;
  /** Past-tense success notice. */
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

/** All resolution actions, in display order. Filtered per result via `isApplicable`. */
export const RESOLUTION_STRATEGIES: readonly ResolutionStrategy[] = [pushStrategy, pullStrategy];
