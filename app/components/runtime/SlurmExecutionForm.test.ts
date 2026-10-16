/**
 * PR #184 finding 1 (P2-1) — the Slurm preview must be compared through the BRIDGE's normalizer.
 *
 * The form used to decide "does the preview on screen still describe the request I am about to
 * submit?" with its own `parseInt` / colon-splitting. That is a SECOND parser for one value, and it
 * drifted from `bridge/runtime/transports/slurmJobs.js`, the only authority on what a resource
 * expression means:
 *
 *   * `parseInt('8G')` is 8 while the bridge reads `8G` as 8192 MiB, so a preview answering `8`
 *     still looked like a match after the memory field became `8G` — the form would submit 8192 MiB
 *     behind a preview that said 8 MiB;
 *   * the same drift ran the other way: a correct preview answering `8G` (8192 MiB) was judged
 *     stale and the request was refused;
 *   * wall-clock was worse: only a three-part `hh:mm:ss` was accepted, so the bridge's own legal
 *     shorthand `60` (3600 seconds) was refused as a stale preview.
 *
 * Every preview below is produced by the REAL `buildResourcePreview`, and the expected reading of
 * every draft is the REAL `parseSlurmMemory` / `parseSlurmTime`. Nothing here re-implements the
 * resource contract inside a fixture.
 */
import { createApp, h, nextTick, reactive } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildResourcePreview, parseSlurmMemory, parseSlurmTime } from '../../../bridge/runtime/transports/slurmJobs.js';
import SlurmExecutionForm from './SlurmExecutionForm.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

let host: HTMLDivElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

function mountLive(initial: Record<string, unknown>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const state = reactive({ ...initial });
  const app = createApp({
    setup() {
      return () => h(SlurmExecutionForm as never, state);
    },
  });
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false });
  app.use(i18n);
  app.mount(host);
  return { root: host, state };
}

function fill(root: HTMLDivElement, values: Record<string, string>) {
  for (const [testId, value] of Object.entries(values)) {
    const input = root.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
}

/** The request the form will submit once every field is filled to `values`. */
const BASE_DRAFT = Object.freeze({
  'slurm-partition': 'cpu', 'slurm-account': '', 'slurm-cpus': '4',
  'slurm-memory': '8', 'slurm-time': '01:00:00', 'slurm-gres': 'none',
});

function draftWith(overrides: Record<string, string>) {
  return { ...BASE_DRAFT, ...overrides };
}

function previewFor(memory: string, time: string) {
  // The REAL bridge preview for this request — the object the port hands back.
  return buildResourcePreview({ partition: 'cpu', account: null, cpus: 4, memory, time, gres: 'none' });
}

function bound(root: HTMLDivElement): string | null {
  return root.querySelector('[data-testid="slurm-resource-preview"]')?.getAttribute('data-bound') ?? null;
}

function problems(root: HTMLDivElement): string {
  return root.querySelector('[data-testid="slurm-form-problems"]')?.textContent ?? '';
}

describe('the Slurm preview is compared through the bridge normalizer, never a second parser', () => {
  it('refuses to submit behind a preview that answers an OLDER memory unit (8 MiB shown, 8G typed)', async () => {
    const submitted: unknown[] = [];
    const live = mountLive({
      available: true,
      // The preview on screen answers `memory: '8'` — 8 MiB, exactly what the bridge normalizes.
      preview: previewFor('8', '01:00:00'),
      onSubmit: (request: unknown) => submitted.push(request),
    });
    // The user retypes the memory as `8G`. The new preview has not come back yet, so the screen
    // still shows 8 MiB while the bridge would parse the request as 8192 MiB.
    fill(live.root, draftWith({ 'slurm-memory': '8G' }));
    await nextTick();
    live.root.querySelector<HTMLButtonElement>('[data-testid="slurm-form-submit"]')?.click();
    await nextTick();

    expect(bound(live.root)).toBe('false');
    expect(problems(live.root)).toContain('preview');
    expect(submitted).toHaveLength(0);
    // The refusal is not an accident of a blank field: the draft is otherwise complete.
    expect(problems(live.root)).not.toContain('required');
  });

  it('accepts a preview that answers the request on screen, in the unit the user typed (8G)', async () => {
    const submitted: unknown[] = [];
    const live = mountLive({
      available: true,
      // The bridge's own preview for `8G`: 8192 MiB.
      preview: previewFor('8G', '01:00:00'),
      onSubmit: (request: unknown) => submitted.push(request),
    });
    fill(live.root, draftWith({ 'slurm-memory': '8G' }));
    await nextTick();
    live.root.querySelector<HTMLButtonElement>('[data-testid="slurm-form-submit"]')?.click();
    await nextTick();

    expect(bound(live.root)).toBe('true');
    expect(submitted).toEqual([{
      resources: { partition: 'cpu', account: null, cpus: 4, memory: '8G', time: '01:00:00', gres: 'none' },
      ownership: 'owned',
    }]);
    // The preview the user saw is the preview the bridge normalized for that request.
    expect(parseSlurmMemory('8G')).toBe(8192);
  });

  it('accepts the bridge legal wall-clock shorthand `60` instead of demanding three colon parts', async () => {
    const submitted: unknown[] = [];
    const live = mountLive({
      available: true,
      // The bridge accepts `60` as 3600 seconds; its preview says so.
      preview: previewFor('8G', '60'),
      onSubmit: (request: unknown) => submitted.push(request),
    });
    fill(live.root, draftWith({ 'slurm-memory': '8G', 'slurm-time': '60' }));
    await nextTick();
    live.root.querySelector<HTMLButtonElement>('[data-testid="slurm-form-submit"]')?.click();
    await nextTick();

    expect(parseSlurmTime('60')).toBe(3600);
    expect(bound(live.root)).toBe('true');
    expect(submitted).toEqual([{
      resources: { partition: 'cpu', account: null, cpus: 4, memory: '8G', time: '60', gres: 'none' },
      ownership: 'owned',
    }]);
  });

  it('still refuses a preview that answers a genuinely different request', async () => {
    const submitted: unknown[] = [];
    const live = mountLive({
      available: true,
      preview: previewFor('8G', '01:00:00'),
      onSubmit: (request: unknown) => submitted.push(request),
    });
    fill(live.root, draftWith({ 'slurm-memory': '8G', 'slurm-time': '10:00:00', 'slurm-gres': 'gpu:a100:2' }));
    await nextTick();
    live.root.querySelector<HTMLButtonElement>('[data-testid="slurm-form-submit"]')?.click();
    await nextTick();

    expect(bound(live.root)).toBe('false');
    expect(problems(live.root)).toContain('preview');
    expect(submitted).toHaveLength(0);
  });
});
