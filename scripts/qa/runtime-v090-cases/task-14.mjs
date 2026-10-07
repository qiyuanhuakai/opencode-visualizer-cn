import { readdirSync } from 'node:fs';
import { instanceFaults } from './task-14-instance.mjs';
import { live } from './task-14-live.mjs';
import { controlled } from './task-14-scenarios.mjs';
export const sourceFiles = [
  ...readdirSync('shared/runtime/native/codex').map(
    (file) => `shared/runtime/native/codex/${file}`,
  ),
  ...['codexDriver', 'codexHistory', 'codexProcess'].flatMap((file) =>
    ['js', 'd.ts'].map((ext) => `bridge/runtime/drivers/${file}.${ext}`),
  ),
  'app/runtime/drivers/codexDriver.test.ts',
  'app/kimiWebHttpProxy.boundaries.test.ts',
  'scripts/qa/runtime-v090-cases/task-14.mjs',
  'scripts/qa/runtime-v090-cases/task-14-fixture.mjs',
  'scripts/qa/runtime-v090-cases/task-14-scenarios.mjs',
  'scripts/qa/runtime-v090-cases/task-14-live.mjs',
  'scripts/qa/runtime-v090-cases/task-14-instance.mjs',
];
export async function run(context) {
  const a = await controlled(context);
  const b = await live(context);
  const c = await instanceFaults(context);
  return {
    scenarios: [...a.scenarios, ...b.scenarios, ...c.scenarios],
    artifacts: [...a.artifacts, ...b.artifacts, ...c.artifacts],
  };
}
