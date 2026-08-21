import { createApp, h, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import ja from '../locales/ja';

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
  const [{ default: SettingsModal }, { i18n }] = await Promise.all([
    import('./SettingsModal.vue'),
    import('../i18n'),
  ]);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(SettingsModal, { open: true });
  app.use(i18n);
  app.mount(host);
  mountedApps.push(() => app.unmount());
  await nextTick();
  return host;
}

function modalBody(host: HTMLElement) {
  const body = host.querySelector('.modal-body');
  expect(body).not.toBeNull();
  return body as HTMLElement;
}

function pageRows(host: HTMLElement) {
  return Array.from(modalBody(host).querySelectorAll(':scope > .setting-row'));
}

type RowShape = {
  tag: string;
  classAttr: string;
  label: string;
  description: string;
};

function expectRowShape(row: Element, shape: RowShape) {
  expect(row.tagName.toLowerCase()).toBe(shape.tag);
  expect(row.getAttribute('class')).toBe(shape.classAttr);
  const info = row.querySelector(':scope > .setting-info');
  expect(info, 'row must contain a direct .setting-info child').not.toBeNull();
  const label = info!.querySelector(':scope > .setting-label');
  const description = info!.querySelector(':scope > .setting-description');
  expect(label, 'row must contain .setting-label').not.toBeNull();
  expect(description, 'row must contain .setting-description').not.toBeNull();
  expect(label!.tagName.toLowerCase()).toBe('div');
  expect(description!.tagName.toLowerCase()).toBe('div');
  expect(label!.textContent).toBe(shape.label);
  expect(description!.textContent).toBe(shape.description);
}

function expectToggleControl(row: Element) {
  const toggle = row.querySelector(':scope > label.toggle-switch');
  expect(toggle, 'row must contain a direct .toggle-switch control').not.toBeNull();
  const input = toggle!.querySelector('input.toggle-input[type="checkbox"]');
  expect(input, 'toggle switch must wrap a checkbox .toggle-input').not.toBeNull();
  expect(toggle!.querySelector('span.toggle-track')).not.toBeNull();
  return input as HTMLInputElement;
}

function expectLinkRow(row: Element, shape: Omit<RowShape, 'tag' | 'classAttr'>) {
  expectRowShape(row, {
    tag: 'button',
    classAttr: 'setting-row setting-link-row',
    ...shape,
  });
  expect(row.getAttribute('type')).toBe('button');
  expect(row.getAttribute('aria-label')).toBe(shape.label);
  const icon = row.querySelector(':scope > svg.iconify');
  expect(icon, 'link row must render the chevron icon control').not.toBeNull();
  expect(icon!.getAttribute('data-icon')).toBe('lucide:chevron-right');
  expect(icon!.getAttribute('class')).toContain('setting-link-icon');
}

async function clickRow(row: Element) {
  (row as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await nextTick();
}

describe('SettingsModal setting-row structure', () => {
  it('renders the root settings rows with the locked DOM structure', async () => {
    // Given: the settings modal is opened on the root page.
    const host = await mountModal();

    // When: the root page rows are collected in order.
    const rows = pageRows(host);

    // Then: all twelve rows render with the exact shared setting-row structure.
    expect(rows).toHaveLength(12);

    expectRowShape(rows[0], {
      tag: 'div',
      classAttr: 'setting-row',
      label: en.settings.language.label,
      description: en.settings.language.description,
    });
    const languageSelect = rows[0].querySelector(':scope > select.language-select');
    expect(languageSelect).not.toBeNull();
    expect(languageSelect!.querySelectorAll('option')).toHaveLength(5);

    expectRowShape(rows[1], {
      tag: 'div',
      classAttr: 'setting-row',
      label: en.settings.enterToSend.label,
      description: en.settings.enterToSend.description,
    });
    expect(expectToggleControl(rows[1]).checked).toBe(false);

    expectRowShape(rows[2], {
      tag: 'div',
      classAttr: 'setting-row',
      label: en.settings.showMinimizeButtons.label,
      description: en.settings.showMinimizeButtons.description,
    });
    expect(expectToggleControl(rows[2]).checked).toBe(true);

    expectRowShape(rows[3], {
      tag: 'div',
      classAttr: 'setting-row',
      label: en.settings.dockAlwaysOpen.label,
      description: en.settings.dockAlwaysOpen.description,
    });
    const dockInput = expectToggleControl(rows[3]);
    expect(dockInput.checked).toBe(false);
    expect(dockInput.disabled).toBe(false);
    expect(rows[3].querySelector('label.toggle-switch')!.getAttribute('title')).toBe(
      en.settings.dockAlwaysOpen.label,
    );

    expectRowShape(rows[4], {
      tag: 'div',
      classAttr: 'setting-row',
      label: en.settings.showOpenInEditorButton.label,
      description: en.settings.showOpenInEditorButton.description,
    });
    expectToggleControl(rows[4]);

    expectRowShape(rows[5], {
      tag: 'div',
      classAttr: 'setting-row setting-row-stack',
      label: en.settings.openInEditorMaxSizeMb.label,
      description: en.settings.openInEditorMaxSizeMb.description,
    });
    const numberGroup = rows[5].querySelector(':scope > .number-setting-group');
    expect(numberGroup).not.toBeNull();
    const numberInput = numberGroup!.querySelector('input.number-input[type="number"]');
    expect(numberInput).not.toBeNull();
    expect(numberInput!.getAttribute('min')).toBe('1');
    expect(numberInput!.getAttribute('max')).toBe('100');
    expect(numberInput!.getAttribute('step')).toBe('1');

    expectRowShape(rows[6], {
      tag: 'div',
      classAttr: 'setting-row',
      label: en.settings.floatingPreviewWordWrap.label,
      description: en.settings.floatingPreviewWordWrap.description,
    });
    expectToggleControl(rows[6]);

    expectLinkRow(rows[7], {
      label: en.settings.editor.label,
      description: en.settings.editor.description,
    });
    expectLinkRow(rows[8], {
      label: en.settings.textTransformers.label,
      description: en.settings.textTransformers.description,
    });
    expectLinkRow(rows[9], {
      label: en.settings.fontSettings.label,
      description: en.settings.fontSettings.description,
    });
    expectLinkRow(rows[10], {
      label: en.settings.experimentalFeatures.label,
      description: en.settings.experimentalFeatures.description,
    });
    expectLinkRow(rows[11], {
      label: en.settings.theme.label,
      description: en.settings.theme.description,
    });
  });

  it('navigates to the editor page via its link row and keeps the label-wrapped tab size row intact', async () => {
    // Given: the settings modal is opened on the root page.
    const host = await mountModal();

    // When: the editor link row is clicked.
    await clickRow(pageRows(host)[7]);

    // Then: the editor page renders with its title and unchanged tab size label row.
    expect(host.querySelector('.modal-title')!.textContent).toBe(en.settings.editor.pageTitle);
    const rows = pageRows(host);
    const tabSizeRow = rows.find((row) => row.tagName.toLowerCase() === 'label');
    expect(tabSizeRow).toBeDefined();
    expect(tabSizeRow!.getAttribute('class')).toBe('setting-row setting-row-stack');
    const info = tabSizeRow!.querySelector(':scope > span.setting-info');
    expect(info).not.toBeNull();
    expect(info!.querySelector(':scope > span.setting-label')!.textContent).toBe(
      en.settings.editor.tabSize.label,
    );
    expect(info!.querySelector(':scope > span.setting-description')!.textContent).toBe(
      en.settings.editor.tabSize.description,
    );
    expect(tabSizeRow!.querySelector(':scope > input.number-input')).not.toBeNull();

    const editInVisRow = rows.find(
      (row) =>
        row.querySelector('.setting-label')!.textContent === en.settings.editor.editInVis.label,
    );
    expect(editInVisRow).toBeDefined();
    expectRowShape(editInVisRow!, {
      tag: 'div',
      classAttr: 'setting-row',
      label: en.settings.editor.editInVis.label,
      description: en.settings.editor.editInVis.description,
    });
    expectToggleControl(editInVisRow!);

    // And: the Electron-only local application row stays absent in the browser runtime.
    expect(
      rows.some(
        (row) =>
          row.querySelector('.setting-label')?.textContent ===
          en.settings.editor.localApplication.label,
      ),
    ).toBe(false);
  });

  it('renders the transformers toggle row with linked label/description ids and aria wiring', async () => {
    // Given: the settings modal is opened on the root page.
    const host = await mountModal();

    // When: the text transformers link row is clicked.
    await clickRow(pageRows(host)[8]);

    // Then: the enabled toggle row keeps its id-linked label/description and aria wiring.
    const rows = pageRows(host);
    expectRowShape(rows[0], {
      tag: 'div',
      classAttr: 'setting-row',
      label: en.settings.textTransformers.enabledLabel,
      description: en.settings.textTransformers.enabledDescription,
    });
    const labelEl = rows[0].querySelector('.setting-label')!;
    const descriptionEl = rows[0].querySelector('.setting-description')!;
    expect(labelEl.id).toBe('settings-text-transformers-enabled-label');
    expect(descriptionEl.id).toBe('settings-text-transformers-enabled-description');
    const toggleInput = expectToggleControl(rows[0]);
    expect(toggleInput.getAttribute('aria-labelledby')).toBe(labelEl.id);
    expect(toggleInput.getAttribute('aria-describedby')).toBe(descriptionEl.id);

    // And: the mapping section keeps its non-shared nested structure untouched.
    const mappingRow = rows[1];
    expect(mappingRow.getAttribute('class')).toBe(
      'setting-row setting-row-stack transformer-settings-section',
    );
    const heading = mappingRow.querySelector(':scope > .transformer-heading');
    expect(heading).not.toBeNull();
    expect(heading!.querySelector('.setting-info .setting-label')!.textContent).toBe(
      en.settings.textTransformers.mappingLabel,
    );
  });

  it('renders the experimental page toggle rows', async () => {
    // Given: the settings modal is opened on the root page.
    const host = await mountModal();

    // When: the experimental features link row is clicked.
    await clickRow(pageRows(host)[10]);

    // Then: all three experimental toggles render as shared setting rows.
    const rows = pageRows(host);
    expect(rows).toHaveLength(3);
    const shapes = [
      en.settings.experimentalFeatures.showCodexButton,
      en.settings.experimentalFeatures.showForgeButton,
      en.settings.experimentalFeatures.showCodexInStatusMonitor,
    ];
    rows.forEach((row, index) => {
      expectRowShape(row, {
        tag: 'div',
        classAttr: 'setting-row',
        label: shapes[index].label,
        description: shapes[index].description,
      });
      expectToggleControl(row);
    });
  });

  it('renders the theme page section rows with their stacked section classes', async () => {
    // Given: the settings modal is opened on the root page.
    const host = await mountModal();

    // When: the theme link row is clicked.
    await clickRow(pageRows(host)[11]);

    // Then: both theme sections keep the shared info structure and section classes.
    const rows = pageRows(host);
    expect(rows).toHaveLength(2);
    expectRowShape(rows[0], {
      tag: 'div',
      classAttr: 'setting-row setting-row-stack theme-settings-section',
      label: en.settings.theme.presetLabel,
      description: en.settings.theme.presetDescription,
    });
    expect(rows[0].querySelector(':scope > .theme-preset-grid')).not.toBeNull();

    expectRowShape(rows[1], {
      tag: 'div',
      classAttr: 'setting-row setting-row-stack theme-settings-section',
      label: en.settings.theme.managementLabel,
      description: en.settings.theme.managementDescription,
    });
    expect(rows[1].querySelector(':scope > .theme-management-area')).not.toBeNull();
  });

  it('renders the fonts page rows with the font row structure', async () => {
    // Given: the settings modal is opened on the root page.
    const host = await mountModal();

    // When: the font settings link row is clicked.
    await clickRow(pageRows(host)[9]);

    // Then: both font rows keep the shared info structure and font row class.
    const rows = pageRows(host);
    expect(rows).toHaveLength(2);
    expectRowShape(rows[0], {
      tag: 'div',
      classAttr: 'setting-row setting-row-font',
      label: en.settings.terminalFontFamily.label,
      description: en.settings.terminalFontFamily.description,
    });
    expect(rows[0].querySelector(':scope > .font-setting-controls')).not.toBeNull();

    expectRowShape(rows[1], {
      tag: 'div',
      classAttr: 'setting-row setting-row-font',
      label: en.settings.appMonospaceFontFamily.label,
      description: en.settings.appMonospaceFontFamily.description,
    });
    expect(rows[1].querySelector(':scope > .font-setting-controls')).not.toBeNull();
  });

  it('disables the dock row when minimize buttons are turned off', async () => {
    // Given: the settings modal is opened with minimize buttons enabled.
    const host = await mountModal();
    const rows = pageRows(host);
    const minimizeInput = expectToggleControl(rows[2]);
    expect(minimizeInput.checked).toBe(true);

    // When: the minimize buttons toggle is switched off.
    minimizeInput.checked = false;
    minimizeInput.dispatchEvent(new Event('change', { bubbles: true }));
    await nextTick();

    // Then: the dock row reflects the disabled state on class, input, and title.
    const dockRow = pageRows(host)[3];
    expect(dockRow.getAttribute('class')).toBe('setting-row setting-row-disabled');
    const dockInput = expectToggleControl(dockRow);
    expect(dockInput.disabled).toBe(true);
    expect(dockInput.checked).toBe(false);
    expect(dockRow.querySelector('label.toggle-switch')!.getAttribute('title')).toBe(
      en.settings.showMinimizeButtons.label,
    );
  });

  it('clamps the open-in-editor max size number input on blur', async () => {
    // Given: the settings modal is opened on the root page.
    const host = await mountModal();
    const input = pageRows(host)[5].querySelector('input.number-input') as HTMLInputElement;
    expect(input.value).toBe('10');

    // When: an out-of-range value is entered and the input loses focus.
    input.value = '999';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await nextTick();

    // Then: the value is clamped to the configured maximum.
    expect(input.value).toBe('100');
  });

  it('re-renders row labels in the newly selected language', async () => {
    // Given: the settings modal is opened in English.
    const host = await mountModal();
    const languageSelect = pageRows(host)[0].querySelector(
      'select.language-select',
    ) as HTMLSelectElement;

    // When: Japanese is selected.
    languageSelect.value = 'ja';
    languageSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await nextTick();

    // Then: the shared row structure re-renders with translated label/description text.
    expect(languageSelect.value).toBe('ja');
    const firstRow = pageRows(host)[0];
    expect(firstRow.querySelector('.setting-label')!.textContent).toBe(ja.settings.language.label);
    expect(firstRow.querySelector('.setting-description')!.textContent).toBe(
      ja.settings.language.description,
    );
  });
});
