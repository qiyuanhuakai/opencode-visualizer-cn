import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const workflowPath = path.join(repoRoot, '.github/workflows/build-electron.yml');
const builderPath = path.join(repoRoot, 'electron-builder.yml');
const entitlementsPath = path.join(repoRoot, 'build/entitlements.mac.plist');
const workflow = readFileSync(workflowPath, 'utf8');
const builder = readFileSync(builderPath, 'utf8');
const entitlements = readFileSync(entitlementsPath, 'utf8');

/** Read a QA script that may not exist yet (RED phase); missing -> '' so assertions fail on content, not on IO. */
function readOptional(relativePath: string): string {
  try {
    return readFileSync(path.join(repoRoot, relativePath), 'utf8');
  } catch {
    return '';
  }
}

const unixQa = () => readOptional('scripts/qa/electron-installer-unix.sh');
const windowsQa = () => readOptional('scripts/qa/electron-installer-windows.ps1');

/** Slice the workflow text of one job block (from `<name>:` up to the next 2-space-indented job key). */
function laneBlock(jobName: string): string {
  const startMarker = `\n  ${jobName}:`;
  const start = workflow.indexOf(startMarker);
  if (start === -1) return '';
  const rest = workflow.slice(start + startMarker.length);
  const next = rest.search(/\n  [a-z0-9-]+:\s*$/m);
  return rest.slice(0, next === -1 ? rest.length : next);
}

// The five native Electron lanes and what each must do on its own runner.
const ELECTRON_LANES = [
  { job: 'build-macos-x64', runner: 'macos-15-intel', platform: 'mac', arch: 'x64' },
  { job: 'build-macos-arm64', runner: 'macos-latest', platform: 'mac', arch: 'arm64' },
  { job: 'build-windows-x64', runner: 'windows-2022', platform: 'win', arch: 'x64' },
  { job: 'build-windows-arm64', runner: 'windows-11-arm', platform: 'win', arch: 'arm64' },
  { job: 'build-linux-x64', runner: 'ubuntu-24.04', platform: 'linux', arch: 'x64' },
] as const;

describe('complete CI workflow', () => {
  it('runs the complete validation and packaging pipeline for every pull request', () => {
    expect(workflow).toMatch(/\n  pull_request:\s*\n/);
    expect(workflow).toContain('run: pnpm lint');
    expect(workflow).toContain('run: pnpm test');
    expect(workflow).toContain('run: pnpm build');
    expect(workflow).toContain('run: pnpm bridge:build');
  });

  it('exposes one aggregate required check that fails on any skipped or neutral lane', () => {
    expect(workflow).toContain('complete-ci:');
    expect(workflow).toContain('name: Complete CI');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain(
      'needs: [validate, build-macos-x64, build-macos-arm64, build-windows-x64, build-windows-arm64, build-linux-x64, bridge-installers]',
    );
    // Every lane result is checked individually: skipped/neutral/cancelled all fail the gate.
    for (const lane of ELECTRON_LANES) {
      const envLine = `LANE_${lane.job.replaceAll('-', '_').toUpperCase()}: \${{ needs.${lane.job}.result }}`;
      expect(workflow).toContain(envLine);
    }
    expect(workflow).toMatch(/if \[ .* != 'success' \]/);
  });

  it('publishes only native bridge installers with VIS releases', () => {
    expect(workflow).toContain('run: pnpm bridge:package-installer');
    expect(workflow).toContain('dist-bridge/installers/*.deb');
    expect(workflow).toContain('dist-bridge/installers/*.pkg');
    expect(workflow).toContain('dist-bridge/installers/*.exe');
    expect(workflow).not.toContain('dist-bridge/vis_bridge*');
    expect(workflow).toContain('runner: ubuntu-24.04-arm');
    expect(workflow).toContain('runner: windows-11-arm');
    expect(workflow).toContain('runner: macos-15-intel');
  });

  it('exercises each native bridge installer through the installed PATH command', () => {
    expect(workflow).toContain('name: Exercise Linux installer');
    expect(workflow).toContain('name: Exercise macOS installer');
    expect(workflow).toContain('name: Exercise Windows installer');
    expect(workflow).toContain('vis_bridge --help');
  });

  it('builds the electron app on five native architecture lanes, one per platform/arch pair', () => {
    for (const lane of ELECTRON_LANES) {
      const block = laneBlock(lane.job);
      expect(block, `lane ${lane.job} must exist`).toContain(`name: Electron ${lane.platform} ${lane.arch}`);
      expect(block).toContain(`runs-on: ${lane.runner}`);
      // Explicit platform/arch flags — no fat/universal builds allowed on any lane.
      expect(block).toContain(`electron-builder --publish never --${lane.platform} --${lane.arch}`);
      // Artifact upload must be scoped to this lane's arch only. dmg/zip/exe keep
      // x64/arm64 in the name; deb and AppImage use format-native tokens
      // (amd64 / x86_64).
      const expectedGlobs = (() => {
        if (lane.platform === 'mac') {
          return [`dist-electron/Vis-*-${lane.arch}-MacOS.dmg`, `dist-electron/Vis-*-${lane.arch}-MacOS.zip`];
        }
        if (lane.platform === 'win') return [`dist-electron/Vis-*-${lane.arch}-Windows.exe`];
        return ['dist-electron/Vis-*-amd64-Linux.deb', 'dist-electron/Vis-*-x86_64-Linux.AppImage'];
      })();
      for (const glob of expectedGlobs) {
        expect(block, `lane ${lane.job} must upload ${glob}`).toContain(glob);
      }
    }
    // No bare dist-electron/*.dmg-style fat uploads may survive anywhere.
    expect(workflow).not.toContain('dist-electron/*.dmg');
  });

  it('runs the qa:electron smoke on the unpacked app before uploading lane artifacts', () => {
    for (const lane of ELECTRON_LANES) {
      const block = laneBlock(lane.job);
      const smokeIndex = block.indexOf('electron-smoke.mjs');
      const uploadIndex = block.indexOf('name: Upload VIS installers');
      expect(smokeIndex, `lane ${lane.job} must run electron-smoke.mjs`).toBeGreaterThan(-1);
      expect(uploadIndex, `lane ${lane.job} must upload artifacts`).toBeGreaterThan(-1);
      expect(smokeIndex, `lane ${lane.job}: smoke must run before upload`).toBeLessThan(uploadIndex);
      // The smoke receipt must confirm the lane's native arch before anything is uploaded.
      expect(block).toContain('VIS_SMOKE_OUT_DIR');
      expect(block).toMatch(/receipt\.json/);
      expect(block).toMatch(new RegExp(`${lane.arch}`));
    }
  });

  it('runs installer QA per lane: windows NSIS, linux deb + AppImage, macos dmg AND zip', () => {
    for (const lane of ELECTRON_LANES) {
      const block = laneBlock(lane.job);
      if (lane.platform === 'mac') {
        expect(block).toContain(
          `bash scripts/qa/electron-installer-unix.sh --platform macos --arch ${lane.arch} --artifacts-dir dist-electron`,
        );
      }
      if (lane.platform === 'linux') {
        expect(block).toContain(
          `bash scripts/qa/electron-installer-unix.sh --platform linux --arch ${lane.arch} --artifacts-dir dist-electron`,
        );
      }
      if (lane.platform === 'win') {
        expect(block).toContain('electron-installer-windows.ps1');
        expect(block).toContain(`-Arch ${lane.arch}`);
      }
    }
    // The unix script must cover BOTH macOS artifacts (mount+launch DMG and unzip+launch ZIP) and
    // BOTH Linux artifacts (install deb and AppImage extract-and-run for FUSE-less hosts).
    expect(unixQa()).toContain('hdiutil attach');
    expect(unixQa()).toContain('hdiutil detach');
    expect(unixQa()).toContain('unzip');
    expect(unixQa()).toContain('dpkg -i');
    expect(unixQa()).toContain('--appimage-extract');
    // Every artifact's executable goes through the smoke driver, which enforces
    // the isolated --user-data-dir profile (electron-smoke.mjs launch args).
    expect(unixQa()).toContain('VIS_ELECTRON_EXECUTABLE');
    expect(unixQa()).toContain('electron-smoke.mjs');
    // Windows ps1: silent NSIS install plus launch/quit through the same smoke driver.
    expect(windowsQa()).toContain("'/S'");
    expect(windowsQa()).toContain('electron-smoke.mjs');
  });

  it('signs macOS ad-hoc without notarization and carries no signing secrets', () => {
    // Explicit ad-hoc identity and disabled notarization in the builder config.
    expect(builder).toMatch(/^  identity: "-"$/m);
    expect(builder).toMatch(/^  notarize: false$/m);
    expect(builder).toContain('hardenedRuntime: true');
    // The entitlements (main and inherit share this file) allow ad-hoc library loading.
    expect(entitlements).toContain('com.apple.security.cs.disable-library-validation');
    // No signing credentials, Developer ID, or notarization secrets anywhere in the CI surface.
    for (const text of [workflow, builder, unixQa(), windowsQa()]) {
      expect(text).not.toContain('CSC_LINK');
      expect(text).not.toContain('CSC_KEY_PASSWORD');
      expect(text).not.toContain('APPLE_ID');
      expect(text).not.toContain('APPLE_APP_SPECIFIC_PASSWORD');
      expect(text).not.toContain('APPLE_TEAM_ID');
      expect(text).not.toContain('Developer ID Application');
      expect(text).not.toContain('notarize: true');
      expect(text).not.toMatch(/identity: "Developer/);
    }
  });
});

describe('electron installer QA scripts', () => {
  it('unix script fails loudly on missing artifacts and rejects wrong arches', () => {
    const script = unixQa();
    expect(script).toMatch(/set -e[uo]/);
    // Missing artifact must be an explicit failure, never an empty glob proceeding silently.
    expect(script).toContain('-f "$');
    expect(script).toContain('exit 1');
    // Arch must be validated against the supported set before any globbing.
    expect(script).toContain('--arch');
    expect(script).toMatch(/x64|arm64/);
    expect(script).toMatch(/die/);
  });

  it('unix script bounds the launch and tears down processes, mounts and temp dirs', () => {
    const script = unixQa();
    // A hung app launch must be bounded (driver watchdog plus a timeout wrapper when available).
    expect(script).toContain('timeout');
    expect(script).toContain('electron-smoke.mjs');
    // Teardown runs on every exit path: kill leftover app processes, detach DMG, remove temp dirs.
    expect(script).toContain('trap ');
    expect(script).toContain('cleanup');
    expect(script).toContain('rm -rf');
    expect(script).toContain('hdiutil detach');
    expect(script).toContain('squashfs-root');
  });

  it('unix script verifies ad-hoc macOS signatures with no TeamIdentifier', () => {
    const script = unixQa();
    expect(script).toContain('codesign --verify --deep --strict');
    expect(script).toContain('codesign -dv');
    expect(script).toMatch(/Signature=adhoc/);
    expect(script).toMatch(/TeamIdentifier/);
    expect(script).toContain('exit 1');
  });

  it('windows script stops on any error and verifies launch, quit and process cleanup', () => {
    const script = windowsQa();
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain('Start-Process');
    expect(script).toContain('ExitCode');
    expect(script).toContain('electron-smoke.mjs');
    // After the smoke driver quits the app, no child processes may remain.
    expect(script).toContain('Get-Process');
    expect(script).toContain('throw');
  });
});
