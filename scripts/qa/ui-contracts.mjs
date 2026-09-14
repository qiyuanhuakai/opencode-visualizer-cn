#!/usr/bin/env node
import { createUiContractsRunner } from './ui-contracts/runner.mjs';
import { uiContractScenarios } from './ui-contracts/scenarios.mjs';

const runner = createUiContractsRunner();

for (const scenario of uiContractScenarios) await runner.run(scenario);

await runner.writeSummary();
console.log(`UI contracts passed: ${runner.results.length} rendered scenarios`);
