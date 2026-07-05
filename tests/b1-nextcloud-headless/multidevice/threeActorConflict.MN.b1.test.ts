// Feature 051 conflict matrix — pair MN slice (parallelizable file).
import { defineThreeActorConflict } from '../support/threeActorConflictSuite';
import { PAIR_CFGS } from '../support/threeActor';
defineThreeActorConflict(PAIR_CFGS.find((c) => c.key === 'MN')!);
