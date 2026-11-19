import { runSshAskpass } from './sshAskpassEntry.js';
try { process.exitCode = await runSshAskpass(); }
catch { process.exitCode = 1; }
