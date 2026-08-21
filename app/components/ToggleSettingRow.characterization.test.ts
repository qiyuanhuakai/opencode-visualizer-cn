import { createApp, h, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../locales/en';

vi.mock('@iconify/vue', () => ({
  Icon: (props: { icon: string }) => h('svg', { class: 'iconify', 'data-icon': props.icon }),
}));

const mountedApps: Array<() => void> = [];

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function mountModal() {
  const [{ default: SettingsModal }, { i18n }, { useSettings }] = await Promise.all([
    import('./SettingsModal.vue'),
    import('../i18n'),
    import('../composables/useSettings'),
  ]);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(SettingsModal, { open: true });
  app.use(i18n);
  app.mount(host);
  mountedApps.push(() => app.unmount());
  await nextTick();
  return { host, settings: useSettings() };
}

function modalBody(host: HTMLElement) {
  const body = host.querySelector('.modal-body');
  expect(body).not.toBeNull();
  return body as HTMLElement;
}

function pageRows(host: HTMLElement) {
  return Array.from(modalBody(host).querySelectorAll(':scope > .setting-row'));
}

async function openPage(host: HTMLElement, rowIndex: number) {
  (pageRows(host)[rowIndex] as HTMLElement).dispatchEvent(
    new MouseEvent('click', { bubbles: true }),
  );
  await nextTick();
}

async function backToRoot(host: HTMLElement) {
  const back = host.querySelector('.modal-back-button');
  expect(back, 'sub-page must render the back button').not.toBeNull();
  (back as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await nextTick();
}

function toggleInput(row: Element) {
  const input = row.querySelector('label.toggle-switch input.toggle-input');
  expect(input, 'row must contain the toggle switch input').not.toBeNull();
  return input as HTMLInputElement;
}

async function flip(input: HTMLInputElement, checked: boolean) {
  input.checked = checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}

/**
 * Canonical serialization of a rendered row: tag names, attributes (sorted,
 * scope ids excluded), and trimmed text — insensitive to attribute order and
 * Vue scope-id churn, sensitive to any structural or content change.
 */
function canonical(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').trim();
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const attrs = Array.from(el.attributes)
    .filter((attr) => !attr.name.startsWith('data-v-'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((attr) => `${attr.name}="${attr.value}"`)
    .join(' ');
  const children = Array.from(el.childNodes)
    .map(canonical)
    .filter((part) => part.length > 0);
  const open =
    attrs.length > 0 ? `<${el.tagName.toLowerCase()} ${attrs}>` : `<${el.tagName.toLowerCase()}>`;
  return `${open}${children.join('')}</${el.tagName.toLowerCase()}>`;
}

describe('SettingsModal toggle rows characterization', () => {
  it('locks the canonical rendered DOM of every toggle setting row', async () => {
    // Given: the settings modal is opened.
    const { host } = await mountModal();

    // When: the root page toggle rows are collected (ordinary + title/disabled variants).
    const rootRows = pageRows(host);
    const canonicalRows: Record<string, string> = {
      enterToSend: canonical(rootRows[1]),
      showMinimizeButtons: canonical(rootRows[2]),
      dockAlwaysOpen: canonical(rootRows[3]),
      showOpenInEditorButton: canonical(rootRows[4]),
      floatingPreviewWordWrap: canonical(rootRows[6]),
    };

    // And: the transformers aria-wired toggle row is captured.
    await openPage(host, 8);
    canonicalRows.textTransformersEnabled = canonical(pageRows(host)[0]);

    // And: the editor page toggle row is captured.
    await backToRoot(host);
    await openPage(host, 7);
    const editorRows = pageRows(host);
    const editInVisRow = editorRows.find(
      (row) =>
        row.querySelector('.setting-label')!.textContent === en.settings.editor.editInVis.label,
    );
    expect(editInVisRow).toBeDefined();
    canonicalRows.editInVis = canonical(editInVisRow!);

    // And: all three experimental page toggle rows are captured.
    await backToRoot(host);
    await openPage(host, 10);
    const experimentalRows = pageRows(host);
    expect(experimentalRows).toHaveLength(3);
    canonicalRows.showCodexButton = canonical(experimentalRows[0]);
    canonicalRows.showForgePanelButton = canonical(experimentalRows[1]);
    canonicalRows.showCodexInStatusMonitor = canonical(experimentalRows[2]);

    // Then: the canonical DOM of all ten toggle rows matches the locked structure.
    expect(canonicalRows).toMatchSnapshot();
  });

  it('emits model updates from ordinary toggles with the locked timing', async () => {
    // Given: the settings modal is opened with enterToSend off.
    const { host, settings } = await mountModal();
    const input = toggleInput(pageRows(host)[1]);
    expect(input.checked).toBe(false);
    expect(settings.enterToSend.value).toBe(false);

    // When: the toggle is switched on via a checkbox change event.
    await flip(input, true);

    // Then: the bound settings model reflects the update after one tick.
    expect(settings.enterToSend.value).toBe(true);

    // And: switching it back off restores the model.
    await flip(toggleInput(pageRows(host)[1]), false);
    expect(settings.enterToSend.value).toBe(false);
  });

  it('locks the dock toggle disabled state, title swap, and model wiring', async () => {
    // Given: the settings modal is opened with minimize buttons enabled.
    const { host, settings } = await mountModal();
    expect(settings.showMinimizeButtons.value).toBe(true);
    const dockRow = () => pageRows(host)[3];
    expect(toggleInput(dockRow()).disabled).toBe(false);
    expect(dockRow().querySelector('label.toggle-switch')!.getAttribute('title')).toBe(
      en.settings.dockAlwaysOpen.label,
    );

    // When: the dock toggle is switched on.
    await flip(toggleInput(dockRow()), true);

    // Then: the dock model updates.
    expect(settings.dockAlwaysOpen.value).toBe(true);

    // When: minimize buttons are switched off.
    await flip(toggleInput(pageRows(host)[2]), false);

    // Then: the dock row becomes disabled, swaps its title, and the composable
    // forces the dock model back off.
    expect(settings.showMinimizeButtons.value).toBe(false);
    expect(toggleInput(dockRow()).disabled).toBe(true);
    expect(toggleInput(dockRow()).checked).toBe(false);
    expect(dockRow().getAttribute('class')).toBe('setting-row setting-row-disabled');
    expect(dockRow().querySelector('label.toggle-switch')!.getAttribute('title')).toBe(
      en.settings.showMinimizeButtons.label,
    );
    expect(settings.dockAlwaysOpen.value).toBe(false);
  });

  it('locks the transformers toggle aria wiring and model update', async () => {
    // Given: the settings modal is opened on the transformers page.
    const { host, settings } = await mountModal();
    await openPage(host, 8);
    const row = pageRows(host)[0];
    const input = toggleInput(row);

    // Then: the input stays wired to the linked label and description ids.
    expect(input.getAttribute('aria-labelledby')).toBe('settings-text-transformers-enabled-label');
    expect(input.getAttribute('aria-describedby')).toBe(
      'settings-text-transformers-enabled-description',
    );
    expect(row.querySelector('.setting-label')!.id).toBe(
      'settings-text-transformers-enabled-label',
    );
    expect(row.querySelector('.setting-description')!.id).toBe(
      'settings-text-transformers-enabled-description',
    );

    // And: toggling updates the bound model.
    const before = settings.textTransformersEnabled.value;
    await flip(input, !before);
    expect(settings.textTransformersEnabled.value).toBe(!before);
  });

  it('emits model updates from the experimental toggles', async () => {
    // Given: the settings modal is opened on the experimental page.
    const { host, settings } = await mountModal();
    await openPage(host, 10);
    const rows = pageRows(host);
    expect(rows).toHaveLength(3);

    // When: each experimental toggle is flipped from its current value.
    // Then: each bound model updates to the flipped value after one tick.
    const codexBefore = settings.showCodexButton.value;
    await flip(toggleInput(rows[0]), !codexBefore);
    expect(settings.showCodexButton.value).toBe(!codexBefore);

    const forgeBefore = settings.showForgePanelButton.value;
    await flip(toggleInput(rows[1]), !forgeBefore);
    expect(settings.showForgePanelButton.value).toBe(!forgeBefore);

    const statusBefore = settings.showCodexInStatusMonitor.value;
    await flip(toggleInput(rows[2]), !statusBefore);
    expect(settings.showCodexInStatusMonitor.value).toBe(!statusBefore);
  });
});
