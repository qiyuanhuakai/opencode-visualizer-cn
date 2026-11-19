import { main } from '../vis_bridge.js';
import { runSshAskpass } from './runtime/transports/sshAskpassEntry.js';

if (process.env.VIS_SSH_ASKPASS_MODE === 'one-shot-v1') {
  void runSshAskpass().then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
} else void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
