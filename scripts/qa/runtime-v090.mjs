#!/usr/bin/env node
import assert from 'node:assert/strict';
import { captureProcess } from './runtime-v090-process.mjs';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artifact, digest, productionSource, sourceSnapshot, validateEvidence, writeJson } from './runtime-v090-evidence.mjs';
import { runLegacy } from './runtime-v090-legacy.mjs';

export function parseSelector(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    assert(['--task', '--case', '--verify', '--out', '--evidence-root'].includes(key), `unknown argument ${key}`);
    assert(!Object.hasOwn(values, key) && typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'duplicate or missing argument');
    values[key] = value;
  }
  assert(Boolean(values['--task']) !== Boolean(values['--verify']), 'task and verify selectors are exclusive');
  assert(values['--out'], '--out required');
  if (values['--task']) {
    assert(/^(?:[1-9]|[1-3][0-9]|4[0-8])$/.test(values['--task']), 'unknown task');
    assert(['happy', 'failure'].includes(values['--case']), 'unknown case');
  } else {
    assert(['F1', 'F2', 'F3', 'F4'].includes(values['--verify']), 'unknown verifier');
    assert(!values['--case'], 'verify cannot select a case');
  }
  return { ...(values['--task'] ? { task: Number(values['--task']), case: values['--case'] } : { verify: values['--verify'] }), out: path.resolve(values['--out']), ...(values['--evidence-root'] ? { evidenceRoot: path.resolve(values['--evidence-root']) } : {}) };
}
function inventory(root) {
  const directories = ['shared/runtime', 'scripts/qa', 'app/dev/runtime-v090'];
  const files = directories.flatMap((directory) => readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name))));
  return [...files.filter((file) => file.startsWith('shared/runtime/') || file.includes('runtime-v090')), 'package.json', ...readdirSync(path.join(root, 'app')).filter((file) => /^runtime.*\.test\.ts$/.test(file)).map((file) => `app/${file}`)];
}
async function execute(selector, root) {
  const outDir = path.dirname(selector.out);
  mkdirSync(outDir, { recursive: true });
  const registration = path.join(root, 'scripts/qa/runtime-v090-cases', selector.verify ? `verify-${selector.verify}.mjs` : `task-${selector.task}.mjs`);
  if (!(selector.task <= 5)) assert(existsSync(registration), `scenario not implemented: ${selector.verify ?? selector.task}`);
  const registered = selector.task <= 5 ? null : await import(pathToFileURL(registration).href);
  if (registered) assert(Array.isArray(registered.sourceFiles) && registered.sourceFiles.length > 0 && typeof registered.run === 'function', 'registration requires production sourceFiles and run');
  const context = { ...selector, root, outDir, temporaryRoot: process.env.VIS_RUNTIME_QA_TEMP };
  if (process.env.VIS_RUNTIME_QA_WORKER === '1') {
    const result = selector.task <= 5 ? await runLegacy(context) : await registered.run(context);
    writeJson(process.env.VIS_RUNTIME_QA_RESULT, result); return;
  }
  const sources = sourceSnapshot(root, [...new Set([...inventory(root), ...(registered?.sourceFiles ?? [])])]);
  const { execFileSync } = await import('node:child_process');
  const productionRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const sourceIdentity = productionSource(root, sources, productionRevision);
  const rawFile = `${selector.out}.${process.pid}.raw.json`;
  const invocation = [process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)];
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), `vis-runtime-qa-owned-${process.pid}-`));
  try {
  const receipt = await captureProcess(invocation, { root, log: `${selector.out}.log`, env: { ...process.env, VIS_RUNTIME_QA_WORKER: '1', VIS_RUNTIME_QA_RESULT: rawFile, VIS_RUNTIME_QA_TEMP: temporaryRoot } });
  const receiptPath = `${selector.out}.receipt.json`;
  writeJson(receiptPath, { ...receipt, selector, invocationCwd: process.cwd(), sourceHashes: sources, productionRevision, productionSource: sourceIdentity, reportSha256: existsSync(rawFile) ? digest(readFileSync(rawFile)) : null });
  assert(receipt.exitCode === 0 && receipt.signal === null && !receipt.interrupted, `scenario process failed; see ${receipt.log}`);
  const result = JSON.parse(readFileSync(rawFile, 'utf8'));
  writeJson(receiptPath, { ...receipt, selector, invocationCwd: process.cwd(), sourceHashes: sources, productionRevision, productionSource: sourceIdentity, reportSha256: digest(readFileSync(rawFile)), scenarioCount: result.scenarios?.length, assertionCount: result.scenarios?.reduce((sum, scenario) => sum + scenario.assertions.length, 0) });
  const manifest = { ...result, schemaVersion: 1, status: 'passed', selector, invocation, productionRevision, productionSource: sourceIdentity, sourceHashes: sources, versions: { node: process.version, package: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, ...result.versions }, exitCode: 0, process: receipt,
    assertions: result.scenarios?.reduce((sum, scenario) => sum + scenario.assertions.length, 0), scenarioCount: result.scenarios?.length,
    artifacts: [...(result.artifacts ?? []), artifact(rawFile, 'scenario-result'), artifact(receiptPath, 'execution-receipt')] };
  validateEvidence(manifest, root);
  writeJson(selector.out, manifest);
  writeJson(`${selector.out}.manifest.json`, manifest);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    writeJson(`${selector.out}.cleanup.json`, { temporaryRoot, removed: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await execute(parseSelector(process.argv.slice(2)), path.resolve(fileURLToPath(new URL('../..', import.meta.url)))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
