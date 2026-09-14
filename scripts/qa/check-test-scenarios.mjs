import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  addOccurrences,
  normalizeTestFile,
  readVitestList,
  testKey,
} from './test-scenario-vitest.mjs';

const EXPECTED_BASELINE = Object.freeze({
  sourceRevision: '9536c4c2b02f67acae98c7220c307d25e2756ec0',
  fileCount: 300,
  runnableCount: 2515,
  expandedCount: 2521,
  skippedCount: 6,
  inventorySha256: 'e33caef8371557ba9cbcbf3ed5765cd890d80ab65f7fde4e861f36c00e129665',
});
const options = { map: 'docs/testing-scenario-map.json' };
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!flag?.startsWith('--') || !value)
    throw new Error('Usage: check-test-scenarios.mjs [--map FILE] [--list FILE] [--run FILE]');
  const name = flag.slice(2);
  if (!['map', 'list', 'run'].includes(name)) throw new Error(`Unknown option: ${flag}`);
  options[name] = value;
}

const root = process.cwd();
const errors = [];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (name) => {
  try {
    return JSON.parse(readFileSync(resolve(root, options[name]), 'utf8'));
  } catch (error) {
    throw new Error(
      `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
const increment = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);
const readList = () => (options.list ? readJson('list') : readVitestList(root));
const compareIdentitySets = (label, expected, actual) => {
  for (const key of expected) if (!actual.has(key)) errors.push(`${label}: missing ${key}`);
  for (const key of actual) if (!expected.has(key)) errors.push(`${label}: unexpected ${key}`);
};

try {
  const map = readJson('map');
  const inventory = map.immutableInventory;
  if (map.schemaVersion !== 2) errors.push(`unsupported schemaVersion: ${map.schemaVersion}`);
  if (!inventory || !Array.isArray(inventory.files) || !Array.isArray(inventory.scenarios))
    errors.push('immutableInventory files/scenarios must be arrays');
  if (map.baseline?.sourceRevision !== EXPECTED_BASELINE.sourceRevision)
    errors.push('baseline source revision changed');
  if (
    map.baseline?.fileCount !== EXPECTED_BASELINE.fileCount ||
    inventory?.files?.length !== EXPECTED_BASELINE.fileCount
  )
    errors.push('baseline file count changed');
  if (
    map.baseline?.expandedScenarioCount !== EXPECTED_BASELINE.expandedCount ||
    inventory?.scenarios?.length !== EXPECTED_BASELINE.expandedCount
  )
    errors.push('baseline expanded scenario count changed');
  if (map.baseline?.discoveredRunnableScenarioCount !== EXPECTED_BASELINE.runnableCount)
    errors.push('baseline runnable count changed');
  if (map.baseline?.skippedCount !== EXPECTED_BASELINE.skippedCount)
    errors.push('baseline skip count changed');
  const inventoryDigest = sha256(JSON.stringify(inventory));
  if (inventoryDigest !== EXPECTED_BASELINE.inventorySha256)
    errors.push(`immutable baseline inventory changed: ${inventoryDigest}`);
  if (map.baseline?.immutableInventorySha256 !== EXPECTED_BASELINE.inventorySha256)
    errors.push('declared immutable inventory digest changed');

  const oldIds = new Set();
  const rowsPerFile = new Map();
  let skippedRows = 0;
  for (const scenario of inventory?.scenarios ?? []) {
    if (typeof scenario.oldId !== 'string' || !scenario.oldId)
      errors.push('baseline scenario has an empty oldId');
    else if (oldIds.has(scenario.oldId)) errors.push(`duplicate baseline oldId: ${scenario.oldId}`);
    else oldIds.add(scenario.oldId);
    increment(rowsPerFile, scenario.oldFile);
    if (!(scenario.parameterRow > 0))
      errors.push(`invalid baseline parameter row: ${scenario.oldId}`);
    if (scenario.baselineStatus === 'skipped') {
      skippedRows += 1;
      if (!scenario.skipReason) errors.push(`missing baseline skip reason: ${scenario.oldId}`);
    } else if (scenario.baselineStatus !== 'passed')
      errors.push(`invalid baseline status: ${scenario.oldId}`);
    const summary = inventory.assertionSummaries?.[scenario.assertionRef];
    if (
      !summary?.sourceBodySha256 ||
      !(summary.representativeAssertions?.length || summary.representativeChecks?.length)
    )
      errors.push(`missing baseline assertion summary: ${scenario.oldId}`);
  }
  if (skippedRows !== EXPECTED_BASELINE.skippedCount)
    errors.push(`expected ${EXPECTED_BASELINE.skippedCount} baseline skips, got ${skippedRows}`);
  for (const file of inventory?.files ?? []) {
    if ((rowsPerFile.get(file.file) ?? 0) !== file.scenarioCount)
      errors.push(`baseline file scenario count mismatch: ${file.file}`);
    if (!/^[a-f0-9]{64}$/.test(file.sourceFileSha256))
      errors.push(`invalid baseline source hash: ${file.file}`);
  }

  const currentTests = new Set();
  for (const test of map.current?.tests ?? []) {
    const key = testKey(test);
    if (currentTests.has(key)) errors.push(`duplicate current test identity: ${key}`);
    currentTests.add(key);
    if (!['runnable', 'conditional'].includes(test.status))
      errors.push(`invalid current test status: ${key}`);
  }
  const { uiContractScenarioNames } = await import('./ui-contracts/scenarios.mjs');
  const browserScenarios = new Set(uiContractScenarioNames);
  compareIdentitySets(
    'browser scenario registry',
    browserScenarios,
    new Set((map.browserInventory ?? []).map((row) => row.scenario)),
  );
  const listedRows = addOccurrences(root, readList());
  const listedTests = new Set(listedRows.map(testKey));

  const assignedIds = new Set();
  const coveredTests = new Set();
  const allowedDispositions = new Set(['retain', 'migrate', 'merge', 'replace']);
  for (const assignment of map.assignments ?? []) {
    if (!oldIds.has(assignment.oldId))
      errors.push(`assignment has unknown oldId: ${assignment.oldId}`);
    else if (assignedIds.has(assignment.oldId))
      errors.push(`duplicate assignment oldId: ${assignment.oldId}`);
    else assignedIds.add(assignment.oldId);
    if (!allowedDispositions.has(assignment.disposition))
      errors.push(`invalid disposition: ${assignment.oldId}`);
    if (!assignment.equivalence) errors.push(`missing equivalence: ${assignment.oldId}`);
    const proof = map.evidenceCatalog?.[assignment.evidenceRef];
    if (!proof?.summary) errors.push(`missing tracked evidence: ${assignment.oldId}`);
    if (
      assignment.disposition !== 'retain' &&
      (proof?.kind !== 'verified-lineage' || !/^[a-f0-9]{64}$/.test(proof.sourceSha256))
    )
      errors.push(`replacement/merge lacks frozen proof digest: ${assignment.oldId}`);
    if (!Array.isArray(assignment.destinations) || assignment.destinations.length === 0)
      errors.push(`empty destinations: ${assignment.oldId}`);
    for (const destination of assignment.destinations ?? []) {
      if (destination.kind === 'test') {
        const key = testKey(destination);
        if (!currentTests.has(key))
          errors.push(`fake or missing test destination for ${assignment.oldId}: ${key}`);
        const registered = (map.current?.tests ?? []).find((row) => testKey(row) === key);
        if (registered?.status === 'runnable' && !listedTests.has(key))
          errors.push(`test destination is not discovered for ${assignment.oldId}: ${key}`);
        coveredTests.add(key);
      } else if (destination.kind === 'browser') {
        if (!browserScenarios.has(destination.scenario))
          errors.push(
            `fake or missing browser destination for ${assignment.oldId}: ${destination.scenario}`,
          );
      } else errors.push(`invalid destination kind for ${assignment.oldId}`);
    }
  }
  compareIdentitySets('oldId assignment coverage', oldIds, assignedIds);

  const newTests = new Set((map.current?.newTests ?? []).map(testKey));
  for (const key of newTests)
    if (!currentTests.has(key)) errors.push(`new test is not in current inventory: ${key}`);
  const runnableTests = new Set(
    (map.current?.tests ?? []).filter((row) => row.status === 'runnable').map(testKey),
  );
  const conditionalTests = new Set(
    (map.current?.tests ?? []).filter((row) => row.status === 'conditional').map(testKey),
  );
  if (runnableTests.size !== map.current?.runnableScenarioCount)
    errors.push('current runnable count mismatch');
  if (conditionalTests.size !== map.current?.conditionalScenarioCount)
    errors.push('current conditional count mismatch');

  for (const key of runnableTests)
    if (!listedTests.has(key)) errors.push(`tracked runnable test is not discovered: ${key}`);
  if (options.run) {
    const run = readJson('run');
    if (!Array.isArray(run.testResults)) errors.push('run.testResults must be an array');
    const assertionRows = [];
    let failed = 0;
    for (const result of run.testResults ?? []) {
      const file = normalizeTestFile(root, result.name);
      for (const assertion of result.assertionResults ?? []) {
        assertionRows.push({
          file,
          name: [...assertion.ancestorTitles, assertion.title].join(' > '),
        });
        if (assertion.status === 'failed') failed += 1;
      }
    }
    const runTests = new Set(addOccurrences(root, assertionRows).map(testKey));
    for (const key of currentTests)
      if (!runTests.has(key)) errors.push(`Vitest run is missing tracked test: ${key}`);
    if (
      run.success !== true ||
      failed ||
      run.numFailedTests ||
      run.numFailedTestSuites ||
      run.unhandledErrors?.length
    )
      errors.push('Vitest run is unsuccessful or contains failures/unhandled errors');
  }

  if (errors.length) {
    console.error(
      JSON.stringify(
        { ok: false, errorCount: errors.length, errors: errors.slice(0, 100) },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } else {
    console.log(
      JSON.stringify(
        {
          ok: true,
          baselineFiles: inventory.files.length,
          baselineScenarios: inventory.scenarios.length,
          assignedOldIds: assignedIds.size,
          trackedTests: currentTests.size,
          discoveredTests: listedTests.size,
          newTests: newTests.size,
          browserScenarios: browserScenarios.size,
          checkedList: true,
          checkedRun: Boolean(options.run),
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
