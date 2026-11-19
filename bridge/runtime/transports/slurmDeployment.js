import { createHash } from 'node:crypto';
import path from 'node:path';
import { objectFields, requireValue } from '../../../shared/runtime/capabilities.js';
import { normalizeSlurmResources } from './slurmJobs.js';
import { buildAllocationResources } from './slurmStepTransport.js';
import { assertIndependentRoots } from './slurmBootstrap.js';

export function parseSlurmDeployment(input) {
  const value = objectFields(input, ['resources', 'computeWorkingRoot', 'computeStateRoot', 'mode'], ['sharedRoot', 'nodeProgram', 'workerPath']);
  requireValue(['tcp', 'relay'].includes(value.mode), 'slurm.mode');
  for (const field of ['computeWorkingRoot', 'computeStateRoot']) {
    requireValue(typeof value[field] === 'string' && path.isAbsolute(value[field]) && !/[\0\r\n]/u.test(value[field]), `slurm.${field}`);
  }
  requireValue(value.computeWorkingRoot !== value.computeStateRoot, 'slurm.roots', 'conflict');
  for (const field of ['nodeProgram', 'workerPath']) {
    if (value[field] !== undefined) requireValue(typeof value[field] === 'string' && path.isAbsolute(value[field]) && !/[\0\r\n]/u.test(value[field]), `slurm.${field}`);
  }
  const resources = normalizeSlurmResources(value.resources);
  return Object.freeze({ ...value, resources, allocation: buildAllocationResources({ compute: resources, ...resources }) });
}

export function slurmRuntimeBinding(intent, computeNode, restartCount) {
  requireValue(typeof computeNode === 'string' && /^[A-Za-z0-9_.-]+$/u.test(computeNode), 'slurm.computeNode');
  requireValue(Number.isSafeInteger(restartCount) && restartCount >= 0, 'slurm.restart');
  const hex = createHash('sha256').update(`${intent.intentId}:${restartCount}`).digest('hex');
  const bridgeInstanceId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { environmentId: intent.environmentId, intentId: intent.intentId, bridgeInstanceId, epoch: restartCount, computeNode, stepId: intent.relayStepId };
}

export function assertSlurmRoots(root, deployment) {
  return assertIndependentRoots({ controlRoot: root, workspaceRoot: deployment.computeWorkingRoot, nativeDataRoot: deployment.computeStateRoot });
}
