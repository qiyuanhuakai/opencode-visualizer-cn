import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runtimeCopy, runtimeCopyKey, runtimeUiMessages, translateRuntimeUi } from './runtimeUi';
import { runtimeEntryMessages } from './runtimeEntry';
import SlurmExecutionForm from '../components/runtime/SlurmExecutionForm.vue';
import SshHostForm from '../components/runtime/SshHostForm.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'eo'] as const;

describe('runtime UI translation coverage', () => {
  it('translates the actual App runtime entry labels and hints in all five languages', () => {
    const keys = ['../App.vue', '../components/SessionTree.vue'].flatMap(entryPath => {
      const source = readFileSync(fileURLToPath(new URL(entryPath, import.meta.url)), 'utf8');
      return [...source.matchAll(/\bt\('(runtime\.[^']+)'/gu)].map(match => match[1]);
    });
    expect(keys.length).toBeGreaterThan(0);
    const messages = createI18n({ legacy: false, locale: 'en', messages: runtimeEntryMessages });
    for (const locale of locales) {
      messages.global.locale.value = locale;
      for (const key of keys) expect(messages.global.t(key)).not.toBe(key);
    }
  });
  it('covers every literal runtime UI translation call in the mounted component surfaces', () => {
    const phrases = new Set<string>(runtimeCopy.map(([message]) => message));
    const missing: string[] = [];
    for (const directory of ['../components/runtime/', '../components/runtime-shell/']) {
      const path = fileURLToPath(new URL(directory, import.meta.url));
      for (const file of readdirSync(path).filter((name) => name.endsWith('.vue'))) {
        const source = readFileSync(`${path}/${file}`, 'utf8');
        for (const match of source.matchAll(/\brt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/gu)) {
          const phrase = match[2]?.replace(/\\u([0-9a-f]{4})/giu, (_escape, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/\\(['"\\])/gu, '$1') ?? '';
          if (!phrases.has(phrase)) missing.push(`${file}: ${phrase}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
  it('keeps every phrase distinct and fully translated in all five languages', () => {
    const phrases = runtimeCopy.map(([message]) => message);
    const keys = phrases.map(runtimeCopyKey);
    expect(new Set(phrases).size).toBe(phrases.length);
    expect(new Set(keys).size).toBe(keys.length);
    const englishKeys = Object.keys(runtimeUiMessages.en).sort();
    for (const locale of locales) {
      const table: Readonly<Record<string, string>> = runtimeUiMessages[locale];
      expect(Object.keys(table).sort()).toEqual(englishKeys);
      for (const row of runtimeCopy) {
        const translated = table[runtimeCopyKey(row[0])];
        expect(translated?.trim().length, `${locale}: ${row[0]}`).toBeGreaterThan(0);
        expect([...translated?.matchAll(/\{(\w+)\}/gu) ?? []].map((match) => match[1]).sort())
          .toEqual([...row[0].matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort());
        if (locale !== 'en' && row[0] !== 'Bridge URL') expect(translated, `${locale}: ${row[0]}`).not.toBe(row[0]);
      }
    }
  });

  it('renders legacy writer guarantees and lease conflicts as readable copy', () => {
    const originalGuarantee = 'one writer lease per task, and at most WRITER_LIMITS.maxWritersPerRepository per repository';
    const originalConflict = 'conflict: host.writer_lease';
    for (const locale of locales) {
      const i18n = createI18n({ legacy: false, locale, messages: runtimeUiMessages });
      const translate = (key: string) => i18n.global.t(key);
      expect(translateRuntimeUi(originalGuarantee, translate)).toBe(
        translate(runtimeCopyKey('Each task has at most one writer lease. Each repository limits simultaneous writers.')),
      );
      expect(translateRuntimeUi(originalConflict, translate)).toBe(
        translate(runtimeCopyKey('Check the writer lease and its Agent session before retrying.')),
      );
    }
  });

  it('updates real form labels when the application locale changes', async () => {
    const root = document.createElement('div'); document.body.appendChild(root);
    const i18n = createI18n({ legacy: false, locale: 'en', messages: runtimeUiMessages });
    const app = createApp({ render: () => h(SlurmExecutionForm, { available: true }) });
    app.use(i18n); app.mount(root);
    cleanups.push(() => { app.unmount(); root.remove(); });
    const expected = ['Compute working directory', '计算节点工作目录', '運算節點工作目錄', '計算ノードの作業ディレクトリ', 'Komputa labordosierujo'];
    for (const [index, locale] of locales.entries()) {
      i18n.global.locale.value = locale; await nextTick();
      expect(root.textContent).toContain(expected[index]);
      expect(root.querySelector<HTMLInputElement>('[data-testid="slurm-working-root"]')?.value).toBe('');
      expect(root.querySelector<HTMLButtonElement>('[data-testid="slurm-form-submit"]')?.disabled).toBe(true);
    }
  });

  it('generates an explicit new Slurm identity and saves a disabled cluster profile', async () => {
    const root = document.createElement('div'); document.body.appendChild(root);
    const saved: unknown[] = [];
    const app = createApp({ render: () => h(SshHostForm, { transportKind: 'slurm', onSave: (value: unknown) => saved.push(value) }) });
    app.use(createI18n({ legacy: false, locale: 'en', messages: runtimeUiMessages }));
    app.mount(root);
    cleanups.push(() => { app.unmount(); root.remove(); });
    root.querySelector<HTMLButtonElement>('[data-testid="slurm-generate-environment"]')?.click();
    await nextTick();
    const environment = root.querySelector<HTMLInputElement>('[data-testid="ssh-environment-id"]')?.value;
    expect(environment).toMatch(/^[\da-f-]{36}$/u);
    for (const [id, value] of [['ssh-name', 'Cluster'], ['ssh-endpoint', 'localhost'], ['ssh-credential-ref', 'system']]) {
      const input = root.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
      if (!input) throw new Error(`Missing input ${id}`);
      input.value = value ?? ''; input.dispatchEvent(new Event('input'));
    }
    await nextTick();
    root.querySelector<HTMLButtonElement>('[data-testid="ssh-host-save"]')?.click();
    expect(saved).toEqual([expect.objectContaining({ enabled: false, transport: { kind: 'slurm', endpoint: 'localhost' }, target: { kind: 'slurm', clusterEnvironmentId: environment } })]);
  });

  it('requires an existing SSH identity without offering cluster identity generation', async () => {
    const root = document.createElement('div'); document.body.appendChild(root);
    const app = createApp({ render: () => h(SshHostForm) });
    app.use(createI18n({ legacy: false, locale: 'en', messages: runtimeUiMessages }));
    app.mount(root);
    cleanups.push(() => { app.unmount(); root.remove(); });
    expect(root.querySelector('[data-testid="slurm-generate-environment"]')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('[data-testid="ssh-environment-id"]')?.value).toBe('');
    expect(root.querySelector<HTMLButtonElement>('[data-testid="ssh-host-save"]')?.disabled).toBe(true);
  });
});
