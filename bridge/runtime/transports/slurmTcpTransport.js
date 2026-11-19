import { connect as netConnect } from 'node:net';

import { requireValue } from '../../../shared/runtime/capabilities.js';
import { buildSshArgv, buildSshEnvironment, sshProgram } from './sshTransport.js';
import { createRelayChannel, dispatchStoreOperation } from './computeRelay.js';
import { assertComputeTarget, createRelayBinding, createRelayHandshake } from './relayHandshake.js';

/**
 * Slurm TCP channel — login side (plan task 29 / Scope 13, first of the two required channels).
 *
 * When login→compute application TCP is permitted, the compute Bridge runs an authenticated TCP
 * listener (`computeRelay` mode `tcp`) and the login side reaches it through an SSH loopback
 * forward. This module owns the login-side dialer:
 *
 *  - it builds the SSH forward argv through the shared `buildSshArgv` (never a shell string);
 *  - it dials the forwarded loopback port and speaks the relay handshake;
 *  - readiness is gated on the relay hello, never on the SSH forward-setup exit;
 *  - the operation target is asserted to be the compute node, so a login fallback is rejected.
 */
export function createSlurmTcpTransport(options = {}) {
  const connect = options.connect ?? netConnect;
  const states = new Map();

  function buildForwardArgv(forward) {
    return buildSshArgv({
      target: options.target ?? { host: forward.remoteHost ?? '127.0.0.1', port: forward.remotePort ?? 23_004 },
      platform: options.platform,
      forward: {
        localHost: forward.localHost ?? '127.0.0.1',
        localPort: forward.localPort ?? 0,
        remoteHost: forward.remoteHost,
        remotePort: forward.remotePort,
      },
      configPath: options.configPath,
      knownHostsFile: options.knownHostsFile,
    });
  }

  return Object.freeze({
    program: () => sshProgram(options.platform),
    forwardArgv: buildForwardArgv,
    environment: (channel) => buildSshEnvironment({ base: options.baseEnv, channel }),
    /**
     * Dials the forwarded loopback port and completes the relay handshake. Resolves `ready` only
     * after the compute relay proved the credential-protected binding.
     */
    async open(input = {}) {
      const forward = input.forward;
      requireValue(forward !== null && typeof forward === 'object', 'forward');
      requireValue(Number.isInteger(forward.localPort), 'forward.localPort');
      const binding = createRelayBinding(input.binding ?? options.binding);
      const target = assertComputeTarget({
        target: { kind: 'compute', node: forward.remoteHost, environmentId: binding.environmentId },
        loginHosts: options.loginHosts ?? [],
      });
      const connectionId = `slurm-tcp-${binding.stepId}`;
      states.set(connectionId, 'connecting');
      const socket = connect({ host: forward.localHost ?? '127.0.0.1', port: forward.localPort });
      const channel = createRelayChannel(socket, {
        handshake: createRelayHandshake({ credential: options.credential, binding }),
        role: 'login',
        timeoutMs: options.timeoutMs,
      });
      if (options.store !== undefined) {
        channel.onStorageRequest((request) => dispatchStoreOperation(options.store, request));
      }
      try {
        await channel.ready;
      } catch (error) {
        states.set(connectionId, 'failed');
        throw error;
      }
      states.set(connectionId, 'ready');
      return Object.freeze({
        connectionId,
        ready: true,
        state: 'ready',
        target,
        binding,
        channel,
        forwardArgv: buildForwardArgv(forward),
        async close() {
          states.set(connectionId, 'closed');
          channel.close();
        },
      });
    },
    state(connectionId) {
      return states.get(connectionId) ?? 'disconnected';
    },
  });
}
