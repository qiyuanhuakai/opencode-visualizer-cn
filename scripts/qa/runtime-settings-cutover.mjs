import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
assert.ok(args.includes('--browser'), 'This probe currently implements the browser channel; native disk proof is runtime-settings-native.test.mjs.');
const session = option('--session');
const origin = option('--origin');
const bridgeUrl = option('--bridge-url');
const output = path.resolve(option('--output'));
const themeFile = path.resolve(option('--theme-file'));
assert.match(session, /^vis-v090-/u, 'Use an owned QA session');
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
assert.match(bridgeUrl, /^ws:\/\/127\.0\.0\.1:\d+\/runtime$/u);
await mkdir(output, { recursive: true });
const run = promisify(execFile);
const browser = async (...command) => (await run('agent-browser', ['--session', session, ...command], { maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const evaluate = async source => JSON.parse(JSON.parse(await browser('eval', `(async()=>JSON.stringify(await (async()=>{${source}})()))()`)));
function effectiveTheme(raw) {
  if (raw === null) return null;
  const prune = value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, prune(item)]).filter(([, item]) => item === null || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length > 0));
  };
  return prune(JSON.parse(JSON.parse(raw).value));
}
async function waitFor(source) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (await evaluate(`return !!(${source});`)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${source}`);
}
async function snapshot() {
  return evaluate(`
    const source = Object.keys(localStorage).filter(key=>key.startsWith('opencode.')).sort().map(key=>[key,localStorage.getItem(key)]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(source)));
    const storage = await (await import('/qa/drafts.js')).inspectSettingsCutover();
    const style = getComputedStyle(document.documentElement);
    return { legacyHash: [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join(''), storage, background:getComputedStyle(document.body).backgroundColor, formBackground:style.getPropertyValue('--ui-form-control-bg'), theme:localStorage.getItem('vis.live-settings.v1.settings.themeTokens.v2'), errors:[...document.querySelectorAll('[role=alert]')].map(node=>node.textContent) };
  `);
}
async function openThemes() {
  await evaluate(`document.querySelector('button[title="Settings"]').click(); return true;`);
  await waitFor(`document.querySelector('dialog[open] button[aria-label="Theme profiles"]')`);
  await evaluate(`document.querySelector('dialog[open] button[aria-label="Theme profiles"]').click(); return true;`);
  await waitFor(`document.querySelector('dialog[open] .theme-preset-select')`);
}
async function reconnect() {
  await waitFor(`document.querySelector('#bridge-url')`);
  const retained = await evaluate(`return document.querySelector('#bridge-url').value;`);
  assert.equal(retained, bridgeUrl, 'Saved Bridge URL must be available during initial setup');
  await evaluate(`document.querySelector('[data-testid="bridge-login"] button[type="submit"]').click(); return true;`);
  await waitFor(`document.querySelector('[data-testid="unified-session-tree"]')`);
}
const before = await snapshot();
assert.equal(await evaluate('return location.origin;'), origin);
assert.equal(before.storage.migration?.phase, 'cutover', 'Use an existing controlled qualified QA profile');
const imported = JSON.parse(await readFile(themeFile, 'utf8'));
const themes = [];
for (const label of ['Default', 'Light Mode', imported.label]) {
  await openThemes();
  if (label === imported.label) {
    await browser('upload', '.theme-import-input', themeFile);
    await waitFor(`[...document.querySelectorAll('.theme-preset-card-title')].some(node=>node.textContent===${JSON.stringify(label)})`);
  }
  await evaluate(`const button=[...document.querySelectorAll('.theme-preset-select')].find(node=>node.querySelector('.theme-preset-card-title')?.textContent===${JSON.stringify(label)}); if(!button)throw new Error('Theme missing');button.click(); return true;`);
  await evaluate(`document.querySelector('dialog[open] button[aria-label="Close settings"]').click();return true;`);
  const selected = await snapshot();
  await browser('screenshot', path.join(output, `theme-${themes.length}-before.png`));
  await browser('reload');
  await reconnect();
  const restored = await snapshot();
  assert.deepEqual(effectiveTheme(restored.theme), effectiveTheme(selected.theme), `${label} effective theme survives reload`);
  assert.equal(restored.background, selected.background, `${label} rendered background survives reload`);
  assert.equal(restored.formBackground, selected.formBackground, `${label} rendered form background survives reload`);
  assert.equal(restored.legacyHash, before.legacyHash, 'Legacy source bytes must remain unchanged');
  assert.equal(restored.storage.pendingHeaders, before.storage.pendingHeaders, 'Settings must not create pending legacy headers');
  assert.deepEqual(restored.errors, []);
  await browser('screenshot', path.join(output, `theme-${themes.length}-after.png`));
  themes.push({ label, selected, restored });
}
const report = { channel:'actual production browser', session, origin, bridgeUrl, fixture: 'Existing controlled target-store cutover; not legacy migration acceptance', before, themes, nativeWindowsExecuted:false };
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, themes:themes.map(theme=>theme.label), passed:true }));
