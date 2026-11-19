import { describe, expect, it } from 'vitest';

import {
  TRANSPORT_ROLES,
  TRANSPORT_CAPABILITIES,
  assertTransportSupportsRole,
  isManagedTransport,
  transportInspection,
} from '../../bridge/runtime/transports/transportContract.js';
import { CONNECTION_ROLES, TRANSPORT_KINDS } from '../../shared/runtime/connectionProfile.js';

describe('transport contract', () => {
  it('declares exactly the four host transports', () => {
    expect([...TRANSPORT_KINDS]).toEqual(['local', 'direct', 'ssh', 'slurm']);
  });

  it('declares management vs execution roles per transport explicitly', () => {
    expect([...CONNECTION_ROLES]).toEqual(['local', 'manager', 'execution']);
    for (const kind of TRANSPORT_KINDS) {
      expect(TRANSPORT_ROLES[kind].length).toBeGreaterThan(0);
      expect(TRANSPORT_CAPABILITIES[kind]).toMatchObject({
        management: expect.any(Boolean),
        execution: expect.any(Boolean),
      });
    }
    // A pure local process is the local full runtime; a Slurm profile is never the
    // local full runtime (it is a login-owned manager or a compute execution target).
    expect(() => assertTransportSupportsRole('local', 'manager')).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
    expect(() => assertTransportSupportsRole('slurm', 'local')).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
    expect(() => assertTransportSupportsRole('slurm', 'execution')).not.toThrow();
    expect(() => assertTransportSupportsRole('ssh', 'execution')).not.toThrow();
    expect(() => assertTransportSupportsRole('direct', 'manager')).not.toThrow();
    expect(() => assertTransportSupportsRole('local', 'local')).not.toThrow();
  });

  it('projects a transport into the RuntimeInspection.transports shape', () => {
    expect(transportInspection('local')).toEqual({ direct: true, ssh: false, slurm: false });
    expect(transportInspection('direct')).toEqual({ direct: true, ssh: false, slurm: false });
    expect(transportInspection('ssh')).toEqual({ direct: false, ssh: true, slurm: false });
    expect(transportInspection('slurm')).toEqual({ direct: false, ssh: false, slurm: true });
  });

  it('distinguishes transports that need a management bridge', () => {
    expect(isManagedTransport('local')).toBe(false);
    expect(isManagedTransport('direct')).toBe(false);
    expect(isManagedTransport('ssh')).toBe(true);
    expect(isManagedTransport('slurm')).toBe(true);
  });

  it('rejects an unknown transport kind instead of guessing', () => {
    expect(() => transportInspection('telnet' as never)).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  });
});
