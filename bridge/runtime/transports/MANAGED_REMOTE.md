# Managed remote runtime configuration

The production bridge configures its profile manager and remote Host operations together. A connected profile only becomes a runtime target after its live hello and capability grant match the profile's persistent environment identifier.

## Credentials

`system` uses the operating system's SSH agent and SSH configuration. `system:password`, `system:passphrase`, and `system:keyboard-interactive` request an interactive challenge. Replies are ephemeral Host operations; they are not stored in the Host journal.

Other `credentialRef` values resolve through `<stateRoot>/remote-credentials.json`. The file contains a JSON object keyed by credential reference:

```json
{
  "production-bridge": {
    "bridgeToken": "replace-with-the-remote-bridge-token"
  }
}
```

An optional `ssh` object accepts `configPath`, `knownHostsPath`, `passphraseRequired`, `method`, and `remotePort`. The credential file must belong to the current user and have no group/other permission bits on POSIX. On Windows, its ACL must belong to the current user and grant access only to that user. `protectFile()` applies the same protection used for temporary SSH challenge files. Unprotected files are rejected before dialing.

Installed Windows bridges use their shipped `vis_bridge.exe` as the SSH askpass executable. Its internal `one-shot-v1` entry consumes a bounded, protected IPC file and prints only the answer. POSIX installations use the staged Node interpreter and askpass module. Both implementations remove consumed secrets before returning them.

## Slurm deployment

The login bridge requires Slurm client commands. Compute execution uses Slurm service and relay steps, with an explicit additional reserve of one CPU and 128 MiB and `gres=none` for the relay. The execution step retains the requested compute CPU, memory, and GRES budget.

`remote.submit` accepts `profileId` and a `deployment` containing `mode` (`tcp` or `relay`), explicit `resources`, `computeWorkingRoot`, and `computeStateRoot`. The working root must already exist on compute and must differ from the state root. Submission returns before readiness. `remote.reconcile` reports queue and bootstrap state.

By default, reconciliation streams the login installation's Node interpreter, bridge/shared source closure, and `node-pty` package through a reserved `srun` stdio step. The compute installation is scoped to the durable intent under `computeStateRoot`. It does not require compute SSH, application TCP, the login control-store filesystem, or system Node. Compute must provide `/bin/sh`, `tar`, and `base64`; the transferred Node executable must match the compute operating system and architecture. The production packaged installation contains the helper closure and interpreter.

For an existing installation, supply both absolute `nodeProgram` and `workerPath`. The stdio relay helper must be beside the supplied compute worker.

`remote.borrow` additionally accepts a running numeric `jobId`. It starts only Vis's service step in that allocation. Detach and manager shutdown preserve the allocation. Stop cancels the exact owned service step and restores the previous job comment without cancelling the allocation. Following an external requeue, an explicit reconnect reconciles the same job and starts a new service epoch; it does not submit a replacement allocation.

Owned allocation requeue and borrowed reconnect preserve registrations. A scheduler marker binds database recovery to the same job/environment and a strictly newer restart count; takeover compares the previous database fence. Ordinary runtime startup never automatically takes over a store owner.
