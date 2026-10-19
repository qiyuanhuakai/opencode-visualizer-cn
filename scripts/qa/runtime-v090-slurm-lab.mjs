/**
 * Task 46 — isolated live-lab builder for REAL sshd + REAL Slurm (controller + login + 2 compute).
 *
 * This module owns the *environment*, never a graded assertion. It brings up a real
 * `slurmctld` (controller), two real `slurmd` (compute) and a real `sshd` (login) inside
 * three real network namespaces plus one login namespace, and records the CLI/daemon
 * versions and the exact host/socket/namespace each compute step actually ran on.
 *
 * Two isolation runtimes are supported and BOTH use real system daemons — no mock:
 *   - `docker`  : a `--privileged` ubuntu:24.04 container. Used on a developer host that
 *                 may not create network namespaces or install packages. Nothing is
 *                 installed on the host: the entire install lands inside the container
 *                 image layer, which `docker rm` discards.
 *   - `native`  : installs into the isolated CI runner itself (GitHub-hosted runner is
 *                 already disposable). Used by `.github/workflows/runtime-v090-qa.yml`.
 *
 * Hard requirement from the plan: a missing namespace/daemon precondition must exit
 * non-zero with a real CI artifact. `startLab()` therefore asserts every daemon is
 * actually listening and every node is actually schedulable before it returns.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LAB_NAME = 'vis-v090-slurm-lab';
export const LAB_IMAGE = 'ubuntu:24.04';

/** The four real network namespaces: one controller, one login, two compute nodes. */
export const LAB_NAMESPACES = Object.freeze(['ctrl', 'login', 'cn1', 'cn2']);
/** Lab-internal /24 behind a real bridge; every node is a real veth peer in a real netns. */
export const LAB_SUBNET = Object.freeze({ bridge: '10.99.0.1', prefix: 24 });
export const LAB_NODES = Object.freeze({
  ctrl: Object.freeze({ ip: '10.99.0.2', host: 'vislab-ctrl', role: 'controller', cpus: 0, memoryMiB: 0, gres: 0 }),
  login: Object.freeze({ ip: '10.99.0.3', host: 'vislab-login', role: 'login', cpus: 0, memoryMiB: 0, gres: 0 }),
  cn1: Object.freeze({ ip: '10.99.0.4', host: 'vislab-cn1', role: 'compute', cpus: 4, memoryMiB: 512, gres: 2 }),
  cn2: Object.freeze({ ip: '10.99.0.5', host: 'vislab-cn2', role: 'compute', cpus: 4, memoryMiB: 512, gres: 2 }),
});
export const SLURM_PORTS = Object.freeze({ slurmctld: 6817, slurmd: 6818 });
/** AC3's load-bearing reserve: a replacement relay must still win with exactly this budget. */
export const RELAY_RESERVE = Object.freeze({ cpus: 1, memoryMiB: 128, gres: 0 });
/** A compute step that occupies its ENTIRE node budget (all CPUs, all memory, all GRES). */
export const COMPUTE_SATURATION = Object.freeze({ cpus: 4, memoryMiB: 512, gres: 2 });

export function parseArgs(argv) {
  const values = { runtime: 'auto', keep: false, timeoutMs: 900000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--runtime') values.runtime = argv[++index];
    else if (argument === '--image') values.image = argv[++index];
    else if (argument === '--out') values.out = argv[++index];
    else if (argument === '--keep') values.keep = true;
    else if (argument === '--timeout-ms') values.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  assert(['auto', 'docker', 'native'].includes(values.runtime), `--runtime must be auto|docker|native, got ${values.runtime}`);
  assert(Number.isInteger(values.timeoutMs) && values.timeoutMs > 0, '--timeout-ms must be a positive integer');
  return values;
}

/** /etc/hosts so each lab node name resolves inside its own namespace (and for the client). */
export function labHostsFile() {
  const lines = ['127.0.0.1 localhost', '::1 localhost ip6-localhost ip6-loopback', 'ff02::1 ip6-allnodes', 'ff02::2 ip6-allrouters'];
  for (const namespace of LAB_NAMESPACES) lines.push(`${LAB_NODES[namespace].ip} ${LAB_NODES[namespace].host}`);
  return `${lines.join('\n')}\n`;
}

const APT_PACKAGES = 'slurm-wlm munge openssh-server iproute2 util-linux procps libpmix2t64';

/**
 * The whole lab, as one deterministic setup script. Kept as a single script so the
 * `docker` and `native` runtimes execute byte-identical daemon setup.
 */
export function labSetupScript() {
  // Emit each node's real address/hostname as literals: the generated bash has no access
  // to the JS helpers, and every node must get its OWN address inside its OWN namespace.
  const nodeLines = LAB_NAMESPACES.map((namespace) => {
    const node = LAB_NODES[namespace];
    return `  ${namespace}) ip=${node.ip} host=${node.host} ;;`;
  }).join('\n');
  return `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

log() { printf '[lab] %s\\n' "$*" >&2; }
fail() { printf '[lab] FATAL: %s\\n' "$*" >&2; exit 70; }

# ---------------------------------------------------------------- 1. install
# Every install lands inside this container/runner only. The user's production host is
# never touched: docker discards the image layer on rm, and native runs on the
# disposable GitHub-hosted isolated runner.
apt-get update -qq >/dev/null 2>&1 || fail "apt-get update failed (no network to archive.ubuntu.com)"
apt-get install -y -qq ${APT_PACKAGES} >/dev/null 2>&1 || fail "apt-get install failed for: ${APT_PACKAGES}"

# ---------------------------------------------------------------- 2. munge (real auth)
install -d -m 0700 -o munge -g munge /etc/munge /var/lib/munge /var/log/munge
# /run/munge MUST be 0755: the slurm user has to traverse it to reach munge.socket.2.
install -d -m 0755 -o munge -g munge /run/munge
dd if=/dev/urandom of=/etc/munge/munge.key bs=1 count=1024 status=none
chown munge:munge /etc/munge/munge.key
chmod 0400 /etc/munge/munge.key
runuser -u munge -- /usr/sbin/munged --force
for _ in $(seq 1 50); do [ -S /run/munge/munge.socket.2 ] && break; sleep 0.1; done
[ -S /run/munge/munge.socket.2 ] || fail "munged did not create /run/munge/munge.socket.2"
# The controller authenticates as the slurm user, so prove the credential works for it.
runuser -u slurm -- munge -n | unmunge | grep -q 'STATUS:.*Success' || fail "slurm user cannot use munge"

# ---------------------------------------------------------------- 3. cgroup v2 delegation
# cgroup/v2 forbids enabling controllers while the namespace-root cgroup still holds
# member processes. Move every process into a child cgroup, then enable all controllers,
# so real slurmstepd cgroups (and therefore real CPU/memory/GRES accounting) work.
mkdir -p /sys/fs/cgroup/init /sys/fs/cgroup/system.slice
for pid in $(cat /sys/fs/cgroup/cgroup.procs 2>/dev/null || true); do
  echo "$pid" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
done
for controller in $(cat /sys/fs/cgroup/cgroup.controllers); do
  echo "+$controller" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
done
[ "$(cat /sys/fs/cgroup/cgroup.procs | wc -l)" -eq 0 ] || fail "could not empty the cgroup namespace root"
[ -n "$(cat /sys/fs/cgroup/cgroup.subtree_control)" ] || fail "no cgroup controllers could be enabled"
# Slurm's cgroup/v2 plugin creates <mountpoint>/system.slice/<node>_slurmstepd.scope.
mkdir -p /sys/fs/cgroup/system.slice

# ---------------------------------------------------------------- 4. network namespaces
# A real bridge with one real veth peer per node. Every daemon runs in its own netns.
ip link add br-lab type bridge
ip addr add ${LAB_SUBNET.bridge}/${LAB_SUBNET.prefix} dev br-lab
ip link set br-lab up
for ns in ${LAB_NAMESPACES.join(' ')}; do
  case "$ns" in
${nodeLines}
  esac
  ip netns add "$ns"
  ip link add "v-$ns" type veth peer name "p-$ns"
  ip link set "p-$ns" netns "$ns"
  ip link set "v-$ns" master br-lab
  ip link set "v-$ns" up
  ip -n "$ns" link set lo up
  ip -n "$ns" addr add "$ip/${LAB_SUBNET.prefix}" dev "p-$ns"
  ip -n "$ns" link set "p-$ns" up
  ip -n "$ns" route add default via ${LAB_SUBNET.bridge}
  # A per-node UTS namespace gives every node a REAL distinct hostname.
  mkdir -p /run/uts && touch "/run/uts/$ns"
  unshare --uts="/run/uts/$ns" hostname "$host"
done
for ns in ${LAB_NAMESPACES.join(' ')}; do
  # 'ip netns list' prints "ctrl (id: 1)"; compare the name column only.
  ip netns list | awk '{print $1}' | grep -qx "$ns" || fail "network namespace $ns was not created"
done

# ---------------------------------------------------------------- 5. sshd on the login node
install -d -m 0755 /run/sshd
ssh-keygen -A >/dev/null 2>&1 || fail "ssh-keygen -A could not generate host keys"
# Real host keys: ECDSA + ED25519 + RSA, each a real ssh-keygen product.
[ -s /etc/ssh/ssh_host_ed25519_key ] || fail "sshd has no ed25519 host key"
[ -s /etc/ssh/ssh_host_ecdsa_key ] || fail "sshd has no ecdsa host key"
cat > /etc/ssh/sshd_config <<'SSHD'
Port 22
ListenAddress 0.0.0.0
HostKey /etc/ssh/ssh_host_ed25519_key
HostKey /etc/ssh/ssh_host_ecdsa_key
HostKey /etc/ssh/ssh_host_rsa_key
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
AllowTcpForwarding yes
GatewayPorts no
X11Forwarding no
Subsystem sftp internal-sftp
SSHD
useradd -m -s /bin/bash labuser 2>/dev/null || true
# useradd leaves the password field '!' (locked); with UsePAM no that blocks pubkey auth.
usermod -p '*' labuser
install -d -m 0700 -o labuser -g labuser /home/labuser/.ssh
touch /home/labuser/.ssh/authorized_keys
chown labuser:labuser /home/labuser/.ssh/authorized_keys
chmod 600 /home/labuser/.ssh/authorized_keys

# ---------------------------------------------------------------- 6. real Slurm cluster
install -d -m 0755 -o slurm -g slurm /var/spool/slurmctld /var/log/slurm /var/run/slurm
install -d -m 0755 /var/spool/slurmd
install -d -m 0755 /var/spool/gres
touch /var/spool/gres/gpu0 /var/spool/gres/gpu1

cat > /etc/slurm/slurm.conf <<'SLURM'
ClusterName=vislab
SlurmctldHost=vislab-ctrl
SlurmUser=slurm
SlurmdUser=root
AuthType=auth/munge
CredType=cred/munge
ProctrackType=proctrack/linuxproc
ReturnToService=2
SlurmctldPort=${SLURM_PORTS.slurmctld}
SlurmdPort=${SLURM_PORTS.slurmd}
StateSaveLocation=/var/spool/slurmctld
SlurmctldPidFile=/var/run/slurm/slurmctld.pid
SlurmdSpoolDir=/var/spool/slurmd
SlurmdPidFile=/var/run/slurm/slurmd.pid
SwitchType=switch/none
MpiDefault=none
SlurmctldLogFile=/var/log/slurm/slurmctld.log
SlurmdLogFile=/var/log/slurm/slurmd.log
SlurmctldDebug=info
SlurmdDebug=info
SlurmdParameters=config_overrides
GresTypes=gpu
NodeName=cn1 NodeAddr=vislab-cn1 NodeHostname=vislab-cn1 CPUs=4 RealMemory=512 Gres=gpu:2 State=UNKNOWN
NodeName=cn2 NodeAddr=vislab-cn2 NodeHostname=vislab-cn2 CPUs=4 RealMemory=512 Gres=gpu:2 State=UNKNOWN
PartitionName=debug Nodes=cn1,cn2 Default=YES MaxTime=INFINITE State=UP
SLURM

# Two real device files -> slurmd genuinely reports gpu:2, matching the node budget.
cat > /etc/slurm/gres.conf <<'GRES'
Name=gpu File=/var/spool/gres/gpu0
Name=gpu File=/var/spool/gres/gpu1
GRES

cat > /etc/slurm/cgroup.conf <<'CGROUP'
CgroupMountpoint=/sys/fs/cgroup
IgnoreSystemd=yes
ConstrainCores=no
ConstrainRAMSpace=no
ConstrainSwapSpace=no
ConstrainDevices=no
CGROUP

# ---------------------------------------------------------------- 7. start the daemons
# nsenter (NOT 'ip netns exec'): ip netns exec remounts a fresh /sys, which unmounts the
# cgroup2 mount and makes Slurm's cgroup plugin fail with "No filesystem mounted".
nsenter --net=/var/run/netns/ctrl --uts=/run/uts/ctrl \\
  runuser -u slurm -- /usr/sbin/slurmctld
for _ in $(seq 1 100); do scontrol ping >/dev/null 2>&1 && break; sleep 0.2; done
scontrol ping >/dev/null 2>&1 || fail "slurmctld is not answering on ${LAB_NODES.ctrl.ip}:${SLURM_PORTS.slurmctld}"

for node in cn1 cn2; do
  nsenter --net="/var/run/netns/$node" --uts="/run/uts/$node" \\
    /usr/sbin/slurmd -N "$node" -D >"/tmp/slurmd-$node.log" 2>&1 &
done

# Record each slurmd's REAL pid here, in the setup script, so a QA lane can stop exactly
# one compute daemon without a pattern that could match the lane's own command line.
sleep 7
for node in cn1 cn2; do
  pgrep -f "slurmd -N $node" > "/run/slurmd-$node.pid" 2>/dev/null || true
  [ -s "/run/slurmd-$node.pid" ] || fail "could not record the $node slurmd pid"
done

nsenter --net=/var/run/netns/login --uts=/run/uts/login \\
  /usr/sbin/sshd -D -e -o PidFile=/run/sshd-login.pid >/tmp/sshd-login.log 2>&1 &

# A real sshd also runs on cn1. That is what makes the jump-host leg a genuine two-hop
# (client -> login bastion -> cn1) AND what makes "compute SSH disabled" a real, testable
# precondition for the relay leg: the relay lane stops THIS daemon and shows the relay
# still works without it.
nsenter --net=/var/run/netns/cn1 --uts=/run/uts/cn1 \\
  /usr/sbin/sshd -D -e -o PidFile=/run/sshd-cn1.pid >/tmp/sshd-cn1.log 2>&1 &

for _ in $(seq 1 150); do
  [ "$(nsenter --net=/var/run/netns/login ss -lnt 2>/dev/null | grep -c ':22 ' || true)" -ge 1 ] && break
  sleep 0.2
done
nsenter --net=/var/run/netns/login ss -lnt 2>/dev/null | grep -q ':22 ' || fail "sshd is not listening on the login namespace"
nsenter --net=/var/run/netns/cn1 ss -lnt 2>/dev/null | grep -q ':22 ' || fail "sshd is not listening on the cn1 namespace"

# ---------------------------------------------------------------- 8. prove readiness
for node in cn1 cn2; do
  scontrol update "NodeName=$node" State=RESUME >/dev/null 2>&1 || true
done
for _ in $(seq 1 150); do
  idle=$(sinfo -h -N -o '%N %t' 2>/dev/null | grep -c 'idle' || true)
  [ "$idle" -ge 2 ] && break
  sleep 0.2
done
idle=$(sinfo -h -N -o '%N %t' 2>/dev/null | grep -c 'idle' || true)
[ "$idle" -ge 2 ] || fail "compute nodes never reached idle (sinfo: $(sinfo -h -N -o '%N %t' 2>/dev/null | tr '\\n' ' '))"

# The completion marker. Everything a QA lane depends on is proven ABOVE this line: both
# sshd listeners are listening, both compute nodes are idle, and the version record is
# written. The Node-side readiness check requires this file, so "lab ready" can never again
# be reported from the slurmctld/slurmd state alone while the login sshd is still starting
# (that race made the first store login fail with a bare 'false !== true' assertion).
rm -f /run/lab-setup-complete
touch /run/lab-setup-complete

# ---------------------------------------------------------------- 9. version + target record (AC4)
srun --version 2>/dev/null | head -1 > /tmp/lab-versions.txt || true
slurmctld --version >> /tmp/lab-versions.txt
slurmd --version >> /tmp/lab-versions.txt
munge --version >> /tmp/lab-versions.txt
/usr/sbin/sshd -V 2>&1 | head -1 >> /tmp/lab-versions.txt
log "lab ready: $(sinfo -h -N -o '%N %t %c %m %G' | tr '\\n' ';')"

# Keep the container alive; the QA driver talks to the lab over docker exec.
exec sleep infinity
`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: options.cwd, env: options.env ?? process.env });
  if (result.error !== undefined && !options.allowFailure) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${(result.stderr ?? '').trim() || (result.stdout ?? '').trim()}`);
  }
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function dockerAvailable() {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; }
}

/** Starts the lab. Returns a descriptor the QA drivers use for every graded command. */
export async function startLab(options = {}) {
  const requested = options.runtime ?? 'auto';
  const runtime = requested === 'auto' ? (dockerAvailable() ? 'docker' : 'native') : requested;
  assert(['docker', 'native'].includes(runtime), `unsupported lab runtime ${runtime}`);
  if (runtime === 'docker') assert(dockerAvailable(), 'docker runtime selected but the docker daemon is unreachable');
  const workdir = mkdtempSync(path.join(os.tmpdir(), 'vis-v090-lab-'));
  const hosts = path.join(workdir, 'hosts');
  const setup = path.join(workdir, 'lab-setup.sh');
  writeFileSync(hosts, labHostsFile());
  writeFileSync(setup, labSetupScript(), { mode: 0o755 });
  const startedAt = new Date().toISOString();
  let containerId = null;
  let setupChild = null;
  if (runtime === 'docker') {
    run('docker', ['rm', '-f', LAB_NAME], { allowFailure: true });
    const started = run('docker', [
      'run', '--rm', '--detach', '--privileged', '--name', LAB_NAME,
      '--hostname', LAB_NODES.ctrl.host,
      '-v', `${hosts}:/etc/hosts:ro`,
      '-v', `${setup}:/lab/lab-setup.sh:ro`,
      options.image ?? LAB_IMAGE,
      'bash', '/lab/lab-setup.sh',
    ]);
    containerId = started.stdout.trim();
    assert(/^[0-9a-f]{12,64}$/.test(containerId), `docker run did not return a container id: ${started.stdout.trim()}`);
  } else {
    // The isolated CI runner IS the test VM. The lab names must resolve there, so append
    // them once (idempotently) instead of bind-mounting /etc/hosts.
    const existing = readFileSync('/etc/hosts', 'utf8');
    if (!existing.includes(LAB_NODES.ctrl.host)) {
      const marker = '# vis-v090-slurm-lab';
      try {
        appendFileSync('/etc/hosts', `\n${marker}\n${LAB_NAMESPACES.map((namespace) => `${LAB_NODES[namespace].ip} ${LAB_NODES[namespace].host}`).join('\n')}\n`);
      } catch (error) {
        // A located diagnosis, not a bare errno: the native runtime installs onto the
        // isolated runner and therefore needs root to edit /etc/hosts.
        throw new Error(`native lab runtime cannot write /etc/hosts (${error.code ?? error.message}): the native runtime installs system packages and edits /etc/hosts, so it must run as root on the isolated runner — use --runtime docker on a host without root`);
      }
    }
    setupChild = spawn('bash', [setup], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    setupChild.unref();
  }
  const lab = { runtime, workdir, containerId, setupChild, hostsFile: hosts, startedAt, descriptor: null };
  await awaitLabReady(lab, options.timeoutMs ?? 900000);
  lab.descriptor = await readLabDescriptor(lab);
  return lab;
}

async function awaitLabReady(lab, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let setupComplete = false;
  while (Date.now() < deadline) {
    const probe = await execLab(lab, ['bash', '-c', 'sinfo -h -N -o "%N %t" 2>/dev/null | sort | tr "\\n" ";"']);
    last = probe.stdout.trim();
    const idle = (last.match(/idle/g) ?? []).length;
    // The setup script's completion marker is written only AFTER it has proven both sshd
    // listeners are listening and both compute nodes reached idle. Waiting for sinfo alone
    // returned while the login namespace's sshd was still starting, so the very first store
    // login raced the daemon and failed. The marker is the setup's own completion signal, so
    // the ready condition is the setup's real end state rather than a parallel, weaker one.
    setupComplete = (await execLab(lab, ['bash', '-c', 'test -f /run/lab-setup-complete && echo yes || echo no'])).stdout.trim() === 'yes';
    if (probe.exitCode === 0 && idle >= 2 && setupComplete) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`lab did not become ready within ${timeoutMs}ms (last sinfo: ${last || '<none>'}; setup completion marker present: ${setupComplete})`);
}

async function readLabDescriptor(lab) {
  const versions = await execLab(lab, ['bash', '-c', 'cat /tmp/lab-versions.txt 2>/dev/null || true']);
  const sinfo = await execLab(lab, ['bash', '-c', 'sinfo -h -N -o "%N|%t|%c|%m|%G|%f" 2>/dev/null']);
  const nodes = sinfo.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, state, cpus, memory, gres, features] = line.split('|');
    return { name, state, cpus, memory, gres, features };
  });
  return {
    runtime: lab.runtime,
    container: lab.containerId,
    namespaces: Object.fromEntries(LAB_NAMESPACES.map((namespace) => [namespace, { ...LAB_NODES[namespace], networkNamespace: `/var/run/netns/${namespace}`, utsNamespace: `/run/uts/${namespace}` }])),
    ports: { ...SLURM_PORTS, sshd: 22 },
    clusterName: 'vislab',
    partition: 'debug',
    versions: Object.fromEntries(versions.stdout.split('\n').filter(Boolean).map((line) => {
      const match = /^(slurm-wlm|munge-\S+|OpenSSH_\S+)/.exec(line.trim());
      return match ? [match[1].replace(/-.*$/, ''), line.trim()] : [line.trim().slice(0, 24), line.trim()];
    })),
    nodes,
    relayReserve: { ...RELAY_RESERVE },
    computeSaturation: { ...COMPUTE_SATURATION },
  };
}

/**
 * Runs one command inside the lab and returns a full receipt (never throws on non-zero).
 * `input` is written to the child's stdin, which is how the relay leg drives a real
 * `srun` step's stdio pipe.
 */
export async function execLab(lab, command, options = {}) {
  const invocation = lab.runtime === 'docker'
    ? ['docker', ['exec', ...(options.input === undefined ? [] : ['-i']), lab.containerId, ...command]]
    : ['bash', ['-c', command.join(' ')]];
  const startedAt = new Date().toISOString();
  const result = spawnSync(invocation[0], invocation[1], {
    encoding: 'utf8', timeout: options.timeoutMs ?? 120000, ...(options.input === undefined ? {} : { input: options.input }),
  });
  return {
    exitCode: result.status ?? -1, signal: result.signal ?? null, invocation,
    startedAt, finishedAt: new Date().toISOString(),
    stdout: result.stdout ?? '', stderr: result.stderr ?? '',
  };
}

export async function stopLab(lab) {
  if (lab.runtime === 'docker') {
    if (lab.containerId) run('docker', ['rm', '-f', lab.containerId], { allowFailure: true });
  } else if (lab.setupChild?.pid) {
    // The native lab runs the daemons as children of the setup script's process group.
    try { process.kill(-lab.setupChild.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  if (!lab.keep) rmSync(lab.workdir, { recursive: true, force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  const lab = await startLab(options);
  const descriptor = lab.descriptor;
  if (options.out) {
    mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(descriptor, null, 2)}\n`);
  }
  console.log(JSON.stringify(descriptor, null, 2));
  if (!options.keep) await stopLab(lab);
}
