import path from 'node:path';
import { artifact } from '../runtime-v090-evidence.mjs';
import { workerScenario, electronBindingScenario } from './task-12-worker.mjs';
import { browserScenario } from './task-12-browser.mjs';

export const sourceFiles = [
  'app/runtime/draftStore.ts',
  ...['draftChunks', 'draftImport', 'importCoordinator', 'legacyBinding', 'nestedJson', 'sourceArchive', 'writerFreeze', 'legacyExport', 'legacyBrowserSource'].map(name => `app/runtime/migration/${name}.ts`),
  'bridge/runtime/migration/importService.js', 'bridge/runtime/migration/importService.d.ts', 'bridge/runtime/migration/manifest.js', 'bridge/runtime/migration/manifest.d.ts',
  'app/utils/storageKeys.ts', 'app/utils/backendHistoryStorage.ts', 'app/utils/composerDraftScheduler.ts',
  'app/backends/codex/auxiliaryStorage.ts', 'app/backends/codex/nativeAuxiliaryStorage.ts',
  'app/App.vue', 'app/components/InputPanel.vue', 'app/components/ToolWindow/Question.vue', 'app/types/sessionDatabase.ts',
  'app/runtimeMigrationImport.test.ts', 'app/backends/codex/auxiliaryStorage.electron.test.ts', 'app/electronPreloadContract.test.ts', 'app/electronSmokeContract.test.ts', 'scripts/qa/electron-smoke-utils.mjs',
  ...['task-12', 'task-12-worker', 'task-12-browser', 'task-12-browser-failures', 'task-12-ui'].map(name => `scripts/qa/runtime-v090-cases/${name}.mjs`),
  'electron/legacyExportSource.mjs', 'electron/sessionStorage.js', 'electron/sessionStorage.d.ts', 'electron/sessionDatabaseIpc.js', 'electron/preload.cjs',
];
export async function run(context) {
  const worker = await workerScenario(context);
  worker.artifacts.push(artifact(path.join(context.outDir, `${context.case}-worker-resources.json`), 'worker-cleanup'));
  const electron = await electronBindingScenario(context);
  const browser = await browserScenario(context);
  const results = [worker, electron, browser];
  return { scenarios: results.map(({ name, assertions }) => ({ name, assertions })), artifacts: results.flatMap(result => result.artifacts) };
}
