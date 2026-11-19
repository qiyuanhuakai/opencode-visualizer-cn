import path from 'node:path';

import { requireValue, textValue } from '../../../shared/runtime/capabilities.js';
import { parseEnvironmentId } from '../../../shared/runtime/identity.js';
import { resolveProfileEnvironment } from '../../../shared/runtime/connectionProfile.js';

/**
 * Slurm bootstrap probe and plan (plan task 28 / Scope 12-13).
 *
 * Control and execution are always separate hosts:
 *  - the login host runs `sbatch`/`squeue`/`scontrol` and owns the persistent control store;
 *  - the compute host runs the Bridge, the Agent and the PTY, and its working path is a
 *    compute-local directory that must be *independent* from the login control root or a
 *    shared delivery path (a shared disk is never silently treated as the local state root).
 *
 * This module is pure (no `node:child_process`) so the same rules are reused by the plan and
 * by the runtime UI. It never installs anything: `automatic` is always false.
 */
export const SLURM_HOST_ROLES = Object.freeze(['login', 'compute']);
export const SLURM_LOGIN_PROGRAMS = Object.freeze(['sbatch', 'squeue', 'scontrol']);
export const SLURM_COMPUTE_PROGRAMS = Object.freeze(['bridge']);
/** Where a compute artifact travels. A shared root is opt-in; the controlled channel is the fallback. */
export const COMPUTE_DELIVERY_CHANNELS = Object.freeze(['slurm-shared-root', 'slurm-controlled-channel']);

function optionalRoot(value, field) {
  if (value === undefined || value === null) return null;
  return textValue(value, field);
}

/** Normalizes a probed host: its role, platform, program availability and roots. */
export function parseSlurmHostProbe(input) {
  requireValue(input !== null && typeof input === 'object' && !Array.isArray(input), 'host');
  requireValue(SLURM_HOST_ROLES.includes(input.role), 'slurm.role', 'unsupported');
  const platform = textValue(input.platform, 'host.platform');
  const programsInput = input.programs ?? {};
  requireValue(programsInput !== null && typeof programsInput === 'object' && !Array.isArray(programsInput), 'host.programs');
  const expected = input.role === 'login' ? SLURM_LOGIN_PROGRAMS : SLURM_COMPUTE_PROGRAMS;
  const programs = {};
  for (const name of expected) programs[name] = programsInput[name] === true;
  const programsReady = expected.every((name) => programs[name] === true);
  return Object.freeze({
    role: input.role,
    platform,
    programs: Object.freeze(programs),
    programsReady,
    bridgeInstalled: input.bridgeInstalled === true,
    bridgeVersion:
      input.bridgeVersion === undefined || input.bridgeVersion === null
        ? null
        : textValue(input.bridgeVersion, 'host.bridgeVersion'),
    controlRoot: optionalRoot(input.controlRoot, 'host.controlRoot'),
    workspaceRoot: optionalRoot(input.workspaceRoot, 'host.workspaceRoot'),
    nativeDataRoot: optionalRoot(input.nativeDataRoot, 'host.nativeDataRoot'),
  });
}

/**
 * The compute working path must not be the login control root or the compute native state
 * root. Sharing any of them would make the SQLite control DB live on an unverified shared
 * disk, or make two writers collide on one working directory.
 */
export function assertIndependentRoots(options = {}) {
  const control = options.controlRoot === undefined || options.controlRoot === null ? null : path.resolve(options.controlRoot);
  const workspace = options.workspaceRoot === undefined || options.workspaceRoot === null ? null : path.resolve(options.workspaceRoot);
  const native = options.nativeDataRoot === undefined || options.nativeDataRoot === null ? null : path.resolve(options.nativeDataRoot);
  requireValue(workspace !== null, 'slurm.roots.workspace');
  if (control !== null) requireValue(control !== workspace, 'slurm.roots', 'conflict');
  if (native !== null) requireValue(native !== workspace, 'slurm.roots', 'conflict');
  return Object.freeze({ independent: true, controlRoot: control, workspaceRoot: workspace, nativeDataRoot: native });
}

/** Chooses the compute artifact delivery channel; install still requires an explicit action. */
export function planComputeDelivery(options = {}) {
  const shared = options.sharedRootAvailable === true;
  return Object.freeze({
    channel: shared ? 'slurm-shared-root' : 'slurm-controlled-channel',
    shared,
    requiresExplicitAction: true,
  });
}

/**
 * Builds the Slurm bootstrap plan. `submitControlHost`/`agentExecutionHost` record the split
 * that the acceptance criteria require: submission control stays on login, and the Agent/PTY
 * never move to login.
 */
export function planSlurmBootstrap(options = {}) {
  const login = options.login;
  const compute = options.compute;
  requireValue(login !== null && typeof login === 'object', 'login');
  requireValue(compute !== null && typeof compute === 'object', 'compute');
  requireValue(login.role === 'login', 'slurm.login.role', 'unsupported');
  requireValue(compute.role === 'compute', 'slurm.compute.role', 'unsupported');
  const loginProbe = parseSlurmHostProbe(login);
  const computeProbe = parseSlurmHostProbe(compute);
  assertIndependentRoots({
    controlRoot: loginProbe.controlRoot,
    workspaceRoot: computeProbe.workspaceRoot,
    nativeDataRoot: computeProbe.nativeDataRoot,
  });
  const environmentId =
    options.profile === undefined || options.profile === null
      ? parseEnvironmentId(options.environmentId)
      : resolveProfileEnvironment(options.profile);
  const delivery = planComputeDelivery({ sharedRootAvailable: options.sharedRootAvailable === true });
  return Object.freeze({
    environmentId,
    controlHost: 'login',
    executionHost: 'compute',
    submitControlHost: 'login',
    agentExecutionHost: 'compute',
    loginControlRoot: loginProbe.controlRoot,
    computeWorkspaceRoot: computeProbe.workspaceRoot,
    computeWorkingRoot: computeProbe.workspaceRoot,
    computeNativeDataRoot: computeProbe.nativeDataRoot,
    login: loginProbe,
    compute: computeProbe,
    delivery,
    automatic: false,
    requiresExplicitAction: computeProbe.bridgeInstalled !== true,
    sharedRootAvailable: options.sharedRootAvailable === true,
  });
}
