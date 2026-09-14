import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runBrowserQa } from '../test-contracts-support.mjs';

const evidenceRoot = '.omo/evidence/test-suite-organization/task-24';

export function createUiContractsRunner() {
  const results = [];
  const networkChangedRetries = [];

  async function saveResult(evidenceDir, result) {
    results.push(result);
    await writeFile(path.join(evidenceDir, 'metrics.json'), `${JSON.stringify(result, null, 2)}\n`);
  }

  async function openFixture(page, baseUrl, scenario) {
    let lastError = new Error(`Could not open ${scenario}`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let networkChanged = false;
      const detectNetworkChange = (request) => {
        if (request.failure()?.errorText === 'net::ERR_NETWORK_CHANGED') networkChanged = true;
      };
      page.on('requestfailed', detectNetworkChange);
      try {
        await page.goto(`${baseUrl}/dev/ui-contracts.html?scenario=${scenario}`, {
          waitUntil: 'networkidle',
        });
        await page.waitForFunction(() => window.__uiContracts?.ready === true, undefined, {
          timeout: 10_000,
        });
        assert.equal(await page.locator('html').getAttribute('data-qa-ready'), 'true');
        page.off('requestfailed', detectNetworkChange);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        page.off('requestfailed', detectNetworkChange);
        if (!networkChanged || attempt > 0) throw lastError;
        networkChangedRetries.push({ scenario, attempt: attempt + 1 });
      }
    }
    throw lastError;
  }

  async function screenshot(page, evidenceDir, name) {
    await page.screenshot({ path: path.join(evidenceDir, name), fullPage: true });
  }

  async function run({ name, viewport, execute }) {
    return runBrowserQa(
      {
        name,
        evidenceDir: `${evidenceRoot}/${name}`,
        viewport,
        httpRoutes: [
          {
            url: /https:\/\/api\.(?:iconify\.design|simplesvg\.com|unisvg\.com)\/.*/,
            handler: (route) =>
              route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
          },
        ],
      },
      async ({ page, baseUrl, evidenceDir, consoleEntries, pageErrors, requestFailures }) => {
        await execute({ page, baseUrl, evidenceDir, openFixture, saveResult, screenshot });
        assert.deepEqual(pageErrors, [], `page errors in ${name}`);
        const unexpectedRequests = requestFailures.filter(
          (entry) => entry.failure?.errorText !== 'net::ERR_NETWORK_CHANGED',
        );
        assert.deepEqual(unexpectedRequests, [], `request failures in ${name}`);
        if (requestFailures.length > 0) {
          assert.ok(
            networkChangedRetries.some((entry) => name.startsWith(entry.scenario)),
            `unrecovered network change in ${name}`,
          );
        }
        const unexpectedConsole = consoleEntries.filter(
          (entry) =>
            (entry.type === 'error' || entry.type === 'warning') &&
            !entry.text.includes('net::ERR_NETWORK_CHANGED'),
        );
        assert.deepEqual(unexpectedConsole, [], `console errors in ${name}`);
      },
    );
  }

  async function writeSummary() {
    await writeFile(
      path.resolve(`${evidenceRoot}/summary.json`),
      `${JSON.stringify({ result: 'passed', networkChangedRetries, scenarios: results }, null, 2)}\n`,
    );
  }

  return { results, run, writeSummary };
}
