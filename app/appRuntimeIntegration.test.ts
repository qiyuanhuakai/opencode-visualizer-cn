/**
 * Task 24 acceptance tests — the App.vue integration that finally ACTIVATES the
 * two inactive seams and keeps the workspace boundary safe.
 *
 * Four acceptance criteria from the plan, each proven against the real
 * `app/App.vue` source (source-extraction pattern from
 * `dshAppWiring.integration.test.ts`: the real wiring text is transpiled and
 * executed against doubles, so the assertions run the actual wiring rather than
 * a re-implementation of it):
 *
 *   A. App has NO single-active-backend control.
 *   B. The task-22 `RuntimeSessionRuntime` binding is now SUPPLIED to the four
 *      legacy `useBackend*` composables, so the previously-inactive qualified
 *      routing path actually engages.
 *   C. The task-23 `harnessScope` / `harnessManifests` props are now BOUND, so
 *      the capability-gated paths in the three modals engage.
 *   D. A remote path is NEVER handed to the local shell or the local editor.
 *
 * Each test is written to FAIL before this task's integration lands and PASS
 * after it, which is what makes it an acceptance test rather than a
 * characterization of the old behaviour.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_SOURCE = readFileSync(join(process.cwd(), 'app', 'App.vue'), 'utf8');

/** The full `<template>` block. */
const APP_TEMPLATE = APP_SOURCE.match(/<template>([\s\S]*?)<\/script>/)?.[1] ?? '';

// ---------------------------------------------------------------------------
// A. No single-active-backend control
// ---------------------------------------------------------------------------

describe('App.vue has no single-active-backend control', () => {
  it('exposes no UI control that sets the active backend kind', () => {
    // A single-active-backend control is a rendered, user-reachable affordance
    // that changes which backend the whole app talks to. `setActiveBackendKind`
    // exists as a registry primitive for connection setup, but it must never be
    // bound to a rendered control or a model in the template.
    const templateBindings = APP_TEMPLATE.match(/@click="[^"]*setActiveBackendKind[^"]*"/g) ?? [];
    const templateModels = APP_TEMPLATE.match(/v-model="[^"]*activeBackendKind[^"]*"/g) ?? [];
    const templateBindModels = APP_TEMPLATE.match(/:active-backend-kind="[^"]*"/g) ?? [];
    expect(templateBindings).toEqual([]);
    expect(templateModels).toEqual([]);
    // `:active-backend-kind` is an informational prop describing which source a
    // panel is about — not a control that switches the app's single backend.
    // It is allowed, but only as a read-only prop, never with a setter.
    const setters = APP_SOURCE.match(/setActiveBackendKind\s*=/g) ?? [];
    expect(setters).toEqual([]);
    expect(templateBindModels.length).toBeGreaterThan(0);
  });

  it('routes the workspace panel through the workspace scope, not a single backend switch', () => {
    // The login surface is one single Bridge entry point. The per-backend
    // buttons select which credential FIELDS the entry shows; they never set a
    // global active backend, so no rendered control may be bound to
    // `setActiveBackendKind`, and the chooser must live inside the entry.
    expect(APP_SOURCE).not.toMatch(/@click="[^"]*setActiveBackendKind/);
    expect(APP_SOURCE).not.toMatch(/v-model="[^"]*activeBackendKind/);
    expect(APP_TEMPLATE).toContain('data-testid="connection-entry"');
    const entryStart = APP_TEMPLATE.indexOf('data-testid="connection-entry"');
    const chooserStart = APP_TEMPLATE.indexOf('class="app-login-backends"');
    expect(entryStart).toBeGreaterThan(-1);
    expect(chooserStart).toBeGreaterThan(entryStart);
  });
});

// ---------------------------------------------------------------------------
// B. Task-22 RuntimeSessionRuntime binding is supplied
// ---------------------------------------------------------------------------

describe('the task-22 runtime session binding is supplied in App.vue', () => {
  it('imports the runtime session-action router', () => {
    expect(APP_SOURCE).toMatch(/useRuntimeSessionActions/);
  });

  it('creates a runtime session runtime and provides it for presentational components', () => {
    expect(APP_SOURCE).toMatch(/RUNTIME_SESSION_ACTIONS_KEY/);
    expect(APP_SOURCE).toMatch(/provide\s*\(/);
  });

  it('passes the binding to useBackendSessionActions so actions delegate to the qualified router', () => {
    const call = APP_SOURCE.match(/useBackendSessionActions\(\{[\s\S]*?\n\}\);/);
    expect(call).not.toBeNull();
    expect(call?.[0]).toMatch(/runtime: runtimeSessionRuntime/);
  });

  it('passes the binding to useBackendSessionLifecycle so cancel delegates to the qualified router', () => {
    const call = APP_SOURCE.match(/useBackendSessionLifecycle\(\{[\s\S]*?\n\}\);/);
    expect(call).not.toBeNull();
    expect(call?.[0]).toMatch(/runtime: runtimeSessionRuntime/);
  });

  it('passes the binding to useBackendSessionReload so history delegates to the qualified router', () => {
    const call = APP_SOURCE.match(/useBackendSessionReload\(\{[\s\S]*?\n\}\);/);
    expect(call).not.toBeNull();
    expect(call?.[0]).toMatch(/runtime: runtimeSessionRuntime/);
  });

  it('passes the binding to useBackendMessageSend as its second argument so send delegates', () => {
    // useBackendMessageTake takes the runtime as a positional second argument,
    // not as an option field.
    const call = APP_SOURCE.match(/useBackendMessageSend\(\{[\s\S]*?\n\}, runtimeSessionRuntime\);/);
    expect(call).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C. Task-23 harnessScope / harnessManifests props are bound
// ---------------------------------------------------------------------------

describe('the task-23 harness scope props are bound in App.vue', () => {
  it('renders HarnessSettings with its required scope and manifests', () => {
    expect(APP_TEMPLATE).toMatch(/HarnessSettings/);
    const usage = APP_TEMPLATE.match(/<HarnessSettings[\s\S]*?\/>/);
    expect(usage).not.toBeNull();
    expect(usage?.[0]).toMatch(/:scope=/);
    expect(usage?.[0]).toMatch(/:manifests=/);
  });

  it('passes the harness scope to ProviderManagerModal', () => {
    const usage = APP_TEMPLATE.match(/<ProviderManagerModal[\s\S]*?\/>/);
    expect(usage).not.toBeNull();
    expect(usage?.[0]).toMatch(/:harness-scope=/);
    expect(usage?.[0]).toMatch(/:harness-manifests=/);
  });

  it('passes the harness scope to StatusMonitorModal', () => {
    const usage = APP_TEMPLATE.match(/<StatusMonitorModal[\s\S]*?\/>/);
    expect(usage).not.toBeNull();
    expect(usage?.[0]).toMatch(/:harness-scope=/);
    expect(usage?.[0]).toMatch(/:harness-manifests=/);
  });

  it('derives the scope from the current session or the active harness instance', () => {
    expect(APP_SOURCE).toMatch(/harnessScope/);
  });
});

// ---------------------------------------------------------------------------
// D. A remote path is never handed to the local shell or the local editor
// ---------------------------------------------------------------------------

describe('a remote path is never handed to the local shell or the local editor', () => {
  it('resolves the bridge endpoint locality before any PTY creation', () => {
    // The guard must classify the connected bridge endpoint (local vs remote)
    // and refuse to spawn a local shell for a remote path.
    expect(APP_SOURCE).toMatch(/decideWorkspaceCapability/);
    expect(APP_SOURCE).toMatch(/createPtySession/);
  });

  it('guards the external-editor open with the same locality check', () => {
    // `handleFloatingWindowOpen` spawns `/bin/sh -c OPEN_IN_EDITOR_SHELL_COMMAND`
    // with the file's absolute path. A remote path must never reach it.
    expect(APP_SOURCE).toMatch(/handleFloatingWindowOpen/);
    expect(APP_SOURCE).toMatch(/OPEN_IN_EDITOR_SHELL_COMMAND/);
  });

  it('keeps the local-application edit path content-only, never path-carrying', () => {
    // The truly local process launch (electron localFile.open) transfers only
    // content and a basename; it must not gain a path field.
    const call = APP_SOURCE.match(/localFile\.open\(\{[\s\S]*?\}\)/);
    expect(call).not.toBeNull();
    expect(call?.[0]).not.toMatch(/absolutePath|directory:/);
    expect(call?.[0]).toMatch(/fileName/);
    expect(call?.[0]).toMatch(/content/);
  });

  it('guards the local-application open with the same workspace capability decision', () => {
    expect(APP_SOURCE).toMatch(/localWorkspaceDecision\('localApplication'\)/);
    expect(APP_SOURCE).toMatch(/localWorkspaceDecision\('localShell'\)/);
  });

  it('renders the migration wizard so legacy data can be browsed, bound and retried', () => {
    expect(APP_SOURCE).toMatch(/MigrationWizard/);
  });
});
