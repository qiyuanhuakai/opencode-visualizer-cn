import { nextTick } from 'vue';
import '../styles/tailwind.css';
import { codeScenario } from './ui-contracts/code';
import { historyScenario } from './ui-contracts/history';
import { pointerScenario } from './ui-contracts/pointer';
import { providerScenario, slashScenario } from './ui-contracts/provider-slash';
import {
  configureFixtureEnvironment,
  fixtureApi,
  scenario,
  waitForRender,
} from './ui-contracts/runtime';
import { settingsScenario } from './ui-contracts/settings';
import { treeScenario } from './ui-contracts/tree';

configureFixtureEnvironment();

async function main(): Promise<void> {
  switch (scenario) {
    case 'tree':
      treeScenario();
      break;
    case 'settings-fonts':
      await settingsScenario('fonts');
      break;
    case 'desktop':
      await settingsScenario('desktop');
      break;
    case 'editor':
      await settingsScenario('editor');
      break;
    case 'provider':
      providerScenario();
      break;
    case 'slash':
      slashScenario();
      break;
    case 'code':
      codeScenario();
      break;
    case 'history':
      historyScenario();
      break;
    case 'pointer':
      pointerScenario();
      break;
    default:
      throw new Error(`Unknown UI contract scenario: ${scenario}`);
  }
  await nextTick();
  await waitForRender();
  fixtureApi.ready = true;
  document.documentElement.dataset.qaReady = 'true';
}

void main();
