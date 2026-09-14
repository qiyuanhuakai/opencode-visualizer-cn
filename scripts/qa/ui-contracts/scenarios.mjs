import { codeLayoutScenario } from './code-layout.mjs';
import { desktopRowsScenario } from './desktop-rows.mjs';
import { editorRowScenario } from './editor-row.mjs';
import { historyClampingScenario } from './history-clamping.mjs';
import { pointerCaptureScenario } from './pointer-capture.mjs';
import { providerScenarios } from './provider.mjs';
import { settingsFontScenarios } from './settings-fonts.mjs';
import { slashMenuScenario } from './slash-menu.mjs';
import { treeSidebarCjkScenario } from './tree-sidebar-cjk.mjs';

export const uiContractScenarios = Object.freeze([
  ...settingsFontScenarios,
  treeSidebarCjkScenario,
  ...providerScenarios,
  desktopRowsScenario,
  editorRowScenario,
  slashMenuScenario,
  codeLayoutScenario,
  historyClampingScenario,
  pointerCaptureScenario,
]);

export const uiContractScenarioNames = Object.freeze(
  uiContractScenarios.map((scenario) => `ui-contracts/${scenario.name}`),
);
