import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountHistoryApp } from './test/appHarness';

const mountedApps: Array<{ readonly unmount: () => void }> = [];

afterEach(() => {
  mountedApps.splice(0).forEach(({ unmount }) => unmount());
});

async function openShell(fixture: Awaited<ReturnType<typeof mountHistoryApp>>) {
  const button = fixture.host.querySelector('.open-shell-button');
  expect(button).toBeInstanceOf(HTMLButtonElement);
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await vi.waitFor(() => {
    if (!fixture.host.querySelector('[data-floating-key="shell:pty-harness"]')) {
      throw new Error('Shell window did not open');
    }
  });
}

describe('App PTY window ownership', () => {
  it('Given duplicate real App shell actions, When one PTY id resolves, Then one terminal window is created and its close deletes that PTY', async () => {
    const fixture = await mountHistoryApp([]);
    mountedApps.push(fixture);
    const button = fixture.host.querySelector('.open-shell-button');
    expect(button).toBeInstanceOf(HTMLButtonElement);

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() =>
      expect(fixture.host.querySelectorAll('[data-floating-key="shell:pty-harness"]')).toHaveLength(
        1,
      ),
    );

    expect(fixture.terminalInstances).toHaveLength(1);
    const close = fixture.host.querySelector(
      '[data-floating-key="shell:pty-harness"] [aria-label="Close window"]',
    );
    expect(close).toBeInstanceOf(HTMLButtonElement);
    close?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() =>
      expect(fixture.host.querySelector('[data-floating-key="shell:pty-harness"]')).toBeNull(),
    );
    expect(fixture.deletePty).toHaveBeenCalledOnce();
    expect(fixture.deletePty).toHaveBeenCalledWith('pty-harness', '/repo');
    expect(fixture.terminalInstances[0]?.disposed).toBe(true);
  });

  it('Given a real App shell window, When the renderer unmounts, Then its terminal closes without deleting the backend PTY', async () => {
    const fixture = await mountHistoryApp([]);
    mountedApps.push(fixture);
    await openShell(fixture);

    mountedApps.pop();
    fixture.unmount();

    expect(fixture.terminalInstances[0]?.disposed).toBe(true);
    expect(fixture.deletePty).not.toHaveBeenCalled();
  });
});
