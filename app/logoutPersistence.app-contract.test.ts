import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App logout persistence contract', () => {
  it('does not present logout until credential deletion succeeds', () => {
    // Given: durable credential deletion can reject a synchronous Electron acknowledgement.
    const appSource = readFileSync(resolve(__dirname, 'App.vue'), 'utf8');
    const logoutStart = appSource.indexOf('async function handleLogout()');
    const logoutEnd = appSource.indexOf('\nonMounted(', logoutStart);
    const logoutSource = appSource.slice(logoutStart, logoutEnd);

    // When: the application handles logout from a connected session.
    const clearIndex = logoutSource.indexOf('credentials.clear()');
    const loginIndex = logoutSource.indexOf("uiInitState.value = 'login'");

    // Then: failure stays connected, offers retry, and every logout mutation follows success.
    expect(logoutStart).toBeGreaterThan(-1);
    expect(logoutEnd).toBeGreaterThan(logoutStart);
    expect(logoutSource).toContain('while (!credentials.clear())');
    expect(logoutSource).toContain("await showConfirm(t('app.errors.logoutPersistenceFailed'))");
    expect(clearIndex).toBeGreaterThan(-1);
    expect(loginIndex).toBeGreaterThan(clearIndex);
    expect(logoutSource.indexOf("loginUsername.value = ''")).toBeGreaterThan(clearIndex);
    expect(logoutSource.indexOf("loginPassword.value = ''")).toBeGreaterThan(clearIndex);
    expect(logoutSource.indexOf('loginRequiresAuth.value = false')).toBeGreaterThan(clearIndex);
  });

  it('does not present an unauthorized login until credential deletion succeeds', () => {
    // Given: the live connection can receive 401/403 while native credential deletion rejects.
    const appSource = readFileSync(resolve(__dirname, 'App.vue'), 'utf8');
    const handlerStart = appSource.indexOf("ge.on('connection.error'");
    const handlerEnd = appSource.indexOf("sessionScope.on('permission.asked'", handlerStart);
    const handlerSource = appSource.slice(handlerStart, handlerEnd);

    // When: the application handles the unauthorized connection event.
    const loadingGuard = handlerSource.indexOf("if (uiInitState.value === 'loading')");
    const recoveryIndex = handlerSource.indexOf('await handleOpenCodeUnauthorized(msg)');
    const loginIndex = handlerSource.indexOf("uiInitState.value = 'login'");

    // Then: rejected cleanup is observed before any login transition.
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(loadingGuard).toBeGreaterThan(-1);
    expect(loadingGuard).toBeLessThan(recoveryIndex);
    expect(recoveryIndex).toBeGreaterThan(-1);
    expect(loginIndex).toBeGreaterThan(recoveryIndex);
  });

  it('does not initialize a backend until replacement credentials persist', () => {
    // Given: credential writes can fail while the login form remains usable.
    const appSource = readFileSync(resolve(__dirname, 'App.vue'), 'utf8');
    const loginStart = appSource.indexOf('function handleLogin()');
    const loginEnd = appSource.indexOf('\nfunction handleAbortInit()', loginStart);
    const loginSource = appSource.slice(loginStart, loginEnd);

    // When: the login handler submits the selected backend credentials.
    const saveIndex = loginSource.indexOf('saveLoginCredentials()');
    const initializationIndex = loginSource.indexOf('void startInitialization()');

    // Then: failed acknowledgement shows a retryable error before initialization can begin.
    expect(loginStart).toBeGreaterThan(-1);
    expect(loginEnd).toBeGreaterThan(loginStart);
    expect(loginSource).toContain('if (!saveLoginCredentials())');
    expect(loginSource).toContain(
      "initErrorMessage.value = t('app.errors.credentialPersistenceFailed')",
    );
    expect(saveIndex).toBeGreaterThan(-1);
    expect(initializationIndex).toBeGreaterThan(saveIndex);
  });
});
