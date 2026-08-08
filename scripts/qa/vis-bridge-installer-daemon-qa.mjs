import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';

const [action, stateDirectory, portText, evidencePath] = process.argv.slice(2);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function spawnCommand() {
  const state = JSON.parse(await readFile(path.join(stateDirectory, 'daemon.json'), 'utf8'));
  const commandPidPath = `${evidencePath}.command-pid`;
  const body = JSON.stringify({
    command: process.execPath,
    args: [
      '-e',
      "const fs=require('fs');fs.writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
      commandPidPath,
    ],
  });
  const commandRequest = request({
    host: '127.0.0.1',
    port: Number(portText),
    path: '/command/exec',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(process.env.VIS_BRIDGE_TOKEN
        ? { Authorization: `Bearer ${process.env.VIS_BRIDGE_TOKEN}` }
        : {}),
    },
  });
  commandRequest.on('socket', (socket) => socket.unref());
  commandRequest.on('error', () => undefined);
  commandRequest.end(body);
  const commandPid = Number.parseInt(await waitForFile(commandPidPath), 10);
  await writeFile(evidencePath, JSON.stringify({ daemonPid: state.pid, commandPid }), 'utf8');
}

async function assertStopped() {
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  for (const [name, pid] of Object.entries(evidence)) {
    if (typeof pid === 'number' && isAlive(pid)) throw new Error(`${name} ${pid} is still running.`);
  }
}

if (action === 'spawn') await spawnCommand();
else if (action === 'assert-stopped') await assertStopped();
else throw new Error(`Unknown installer daemon QA action: ${action}`);
