import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const workflowPath = path.join(repoRoot, '.github/workflows/build-electron.yml');
const builderPath = path.join(repoRoot, 'electron-builder.yml');
const packagePath = path.join(repoRoot, 'package.json');
const entitlementsPath = path.join(repoRoot, 'build/entitlements.mac.plist');
const microscopeIgnorePath = path.join(repoRoot, '.microscope/ignore.md');
const workflow = readFileSync(workflowPath, 'utf8');
const builder = readFileSync(builderPath, 'utf8');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
  devDependencies?: Record<string, string>;
};
const entitlements = readFileSync(entitlementsPath, 'utf8');
const microscopeIgnore = readFileSync(microscopeIgnorePath, 'utf8');

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

// js-yaml is only a transitive dep (hoisted into the pnpm store), not declared
// directly; load it from the store instead of adding a dependency.
const requireFromRepo = createRequire(path.join(repoRoot, 'ci-workflow-test.cjs'));
const jsYaml = requireFromRepo('./node_modules/.pnpm/node_modules/js-yaml') as {
  load(text: string): unknown;
};

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
}
interface WorkflowJob {
  steps?: WorkflowStep[];
  needs?: string | string[];
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
}
interface WorkflowDoc {
  jobs?: Record<string, WorkflowJob>;
}

/** Parsed workflow structure — ordering assertions read this, never raw text. */
const doc = jsYaml.load(workflow) as WorkflowDoc;

function jobSteps(job: WorkflowJob | undefined): WorkflowStep[] {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function stepIndexOf(job: WorkflowJob | undefined, match: (step: WorkflowStep) => boolean, label: string): number {
  const index = jobSteps(job).findIndex(match);
  expect(index, `${label} step must exist`).toBeGreaterThanOrEqual(0);
  return index;
}

const PTY_STEP = 'Verify node-pty across runtimes (VIS_PTY_OK)';
const BRIDGE_LANE_OS: Record<string, string> = { linux: 'Linux', macos: 'macOS', windows: 'Windows' };

/** The step that removes the bridge binary on this lane (Windows: the script that runs the uninstaller). */
function isBridgeRemovalStep(step: WorkflowStep, os: string): boolean {
  const run = step.run ?? '';
  if (os === 'Linux') return run.includes('dpkg -r');
  if (os === 'macOS') return run.includes('rm /usr/local/bin/vis_bridge');
  return run.includes('vis-bridge-installer-windows.ps1');
}

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
  {
    job: 'build-macos-x64',
    runner: 'macos-15-intel',
    platform: 'mac',
    arch: 'x64',
    unpackedDir: 'dist-electron/mac',
  },
  {
    job: 'build-macos-arm64',
    runner: 'macos-latest',
    platform: 'mac',
    arch: 'arm64',
    unpackedDir: 'dist-electron/mac-arm64',
  },
  {
    job: 'build-windows-x64',
    runner: 'windows-2022',
    platform: 'win',
    arch: 'x64',
    unpackedDir: 'dist-electron/win-unpacked',
  },
  {
    job: 'build-windows-arm64',
    runner: 'windows-11-arm',
    platform: 'win',
    arch: 'arm64',
    unpackedDir: 'dist-electron/win-arm64-unpacked',
  },
  {
    job: 'build-linux-x64',
    runner: 'ubuntu-24.04',
    platform: 'linux',
    arch: 'x64',
    unpackedDir: 'dist-electron/linux-unpacked',
  },
] as const;

describe('complete CI workflow', () => {
  it('uses the electron-builder release that fixes ARM64 NSIS payload extraction', () => {
    expect(packageJson.devDependencies?.['electron-builder']).toBe('^26.15.7');
  });

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

  it('lets each CI lane select exactly one architecture instead of rebuilding config-wide arch lists', () => {
    expect(builder).not.toMatch(/^\s+arch:\s*$/m);
    for (const lane of ELECTRON_LANES) {
      expect(laneBlock(lane.job)).toContain(
        `electron-builder --publish never --${lane.platform} --${lane.arch}`,
      );
    }
  });

  it('launches the exact unpacked directory produced for each lane architecture', () => {
    for (const lane of ELECTRON_LANES) {
      const block = laneBlock(lane.job);
      expect(block, `${lane.job} must select ${lane.unpackedDir}`).toContain(lane.unpackedDir);
      expect(
        block,
        `${lane.job} must not select the first arbitrary unpacked directory`,
      ).not.toContain('Select-Object -First 1');
      expect(
        block,
        `${lane.job} must not assume every platform uses a *-unpacked directory`,
      ).not.toContain("-name '*-unpacked'");
    }
  });

  it('keeps the Chromium sandbox enabled on Ubuntu 24.04 by allowing user namespaces on the ephemeral runner', () => {
    const block = laneBlock('build-linux-x64');
    const commands = jobSteps(doc.jobs?.['build-linux-x64'])
      .map((step) => step.run ?? '')
      .join('\n');
    const usernsIndex = block.indexOf('kernel.apparmor_restrict_unprivileged_userns=0');
    const smokeIndex = block.indexOf('electron-smoke.mjs');
    expect(usernsIndex).toBeGreaterThan(-1);
    expect(usernsIndex).toBeLessThan(smokeIndex);
    expect(commands).not.toContain('--no-sandbox');
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
    expect(unixQa()).toContain('sudo apt-get install -y "$deb"');
    expect(unixQa()).not.toContain('sudo dpkg -i');
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
    for (const lane of ELECTRON_LANES.filter(({ platform }) => platform === 'mac')) {
      expect(laneBlock(lane.job)).toContain('CSC_FOR_PULL_REQUEST: true');
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

  it('unix script bounds launch and tears down only its owned process groups', () => {
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
    expect(script).toContain('"${SMOKE_PROCESS_GROUPS[@]-}"');
    expect(script).toContain('kill -TERM -- "-$pgid"');
    expect(script).not.toContain('LAUNCHED_EXES');
    expect(script).not.toContain('launched_pids');
    expect(script).toContain('"${WORK_DIRS[@]-}"');
  });

  it('unix smoke launch never expands an empty macOS launcher argument', () => {
    const script = unixQa();
    expect(script).not.toContain('"${launcher[@]-}"');
    expect(script).toContain('timeout --signal=TERM --kill-after=30s 300s xvfb-run -a node');
    expect(script).toContain('timeout --signal=TERM --kill-after=30s 300s node');
  });

  it('unix constrained-host cleanup removes only a generated child directory', () => {
    const script = unixQa();
    expect(script).toContain('DEB_PARENT="$VIS_QA_DEB_INSTALL_ROOT"');
    expect(script).toContain('mktemp -d "${DEB_PARENT%/}/vis-deb-qa-XXXXXX"');
    expect(script).not.toContain('rm -rf "$DEB_ROOT"');
  });

  it('unix system cleanup never removes a package that predated the QA run', () => {
    const script = unixQa();
    expect(script).toContain('DEB_PREEXISTED=0');
    expect(script).toContain('DEB_PREEXISTED=1');
    expect(script).toMatch(/DEB_PREEXISTED[^\n]*==[^\n]*1[\s\S]*?return/);
  });

  it('unix script verifies ad-hoc macOS signatures with no TeamIdentifier', () => {
    const script = unixQa();
    expect(script).toContain('codesign --verify --deep --strict');
    expect(script).toContain('codesign -dv');
    expect(script).toMatch(/Signature=adhoc/);
    expect(script).toMatch(/TeamIdentifier/);
    expect(script).toContain('TeamIdentifier=not set');
    expect(script).toContain('exit 1');
  });

  it('windows script stops on any error and verifies launch, quit and process cleanup', () => {
    const script = windowsQa();
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain('Start-Process');
    expect(script).toContain("@('/S', '/currentuser', \"/D=$installDir\")");
    expect(script).toContain('ExitCode');
    expect(script).toContain('electron-smoke.mjs');
    // After the smoke driver quits the app, no child processes may remain.
    expect(script).toContain('Get-Process');
    expect(script).toContain('throw');
  });

  it('windows script discovers the installed Vis executable and bounds uninstall', () => {
    const script = windowsQa();
    expect(script).toContain('[Guid]::NewGuid()');
    expect(script).toContain("Get-ChildItem $installDir -Filter 'Vis.exe' -File -Recurse");
    expect(script).not.toContain("Get-ChildItem $programsDir -Filter 'Vis.exe'");
    expect(script).toContain('$installationOwned = $false');
    expect(script).toContain('$installationOwned = $true');
    expect(script).toContain('if ($installationOwned)');
    expect(script).toContain('$uninstallDeadline');
    expect(script).not.toMatch(/Start-Process[^\n]+Uninstall[^\n]+-Wait/);
  });
});

describe('review coverage configuration', () => {
  it('keeps production scripts, tests and package manifests visible to code review', () => {
    const rules = microscopeIgnore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(rules).not.toContain('scripts/**');
    expect(rules).not.toContain('**/package.json');
    expect(rules).not.toContain('**/*.test.ts');
  });
});

describe('workflow step ordering (parsed YAML)', () => {
  // allow: SIZE_OK — mandated two-file fix scope (f3-1/f3-11) forbids extracting these helpers to a new file.
  it('runs node-pty verification before removing the bridge binary in every bridge lane', () => {
    const job = doc.jobs?.['bridge-installers'];
    const lanes = job?.strategy?.matrix?.include ?? [];
    for (const lane of lanes) {
      const os = BRIDGE_LANE_OS[lane.platform];
      if (os === undefined) throw new Error(`bridge lane platform ${lane.platform} is not linux/macos/windows`);
      const ptyIndex = stepIndexOf(
        job,
        (s) => s.name === PTY_STEP && (s.if ?? '').includes(`runner.os == '${os}'`),
        `bridge ${os} pty-verify`,
      );
      const removalIndex = stepIndexOf(job, (s) => isBridgeRemovalStep(s, os), `bridge ${os} removal`);
      expect(ptyIndex, `bridge ${os}: pty verification must precede binary removal`).toBeLessThan(removalIndex);
    }
  });

  it('runs bridge binary removal as a guaranteed cleanup step (if: always())', () => {
    const job = doc.jobs?.['bridge-installers'];
    const removals = jobSteps(job).filter((s) => isBridgeRemovalStep(s, 'Linux') || isBridgeRemovalStep(s, 'macOS'));
    expect(removals, 'linux and macOS lanes must each have a dedicated removal step').toHaveLength(2);
    for (const removal of removals) {
      expect(removal.if ?? '', 'removal step must run even after earlier steps fail').toContain('always()');
    }
  });

  it('runs the electron smoke before uploading artifacts in every electron lane', () => {
    for (const lane of ELECTRON_LANES) {
      const job = doc.jobs?.[lane.job];
      const smokeIndex = stepIndexOf(job, (s) => (s.run ?? '').includes('electron-smoke.mjs'), `${lane.job} smoke`);
      const uploadIndex = stepIndexOf(job, (s) => s.name === 'Upload VIS installers', `${lane.job} upload`);
      expect(smokeIndex, `${lane.job}: smoke must run before upload`).toBeLessThan(uploadIndex);
    }
  });

  it('complete-ci needs exactly the lane set', () => {
    const job = doc.jobs?.['complete-ci'];
    const needs = Array.isArray(job?.needs) ? job.needs : typeof job?.needs === 'string' ? job.needs.split(/,\s*/) : [];
    const laneSet = [
      'validate',
      'build-macos-x64',
      'build-macos-arm64',
      'build-windows-x64',
      'build-windows-arm64',
      'build-linux-x64',
      'bridge-installers',
    ];
    expect([...needs].sort()).toEqual([...laneSet].sort());
    expect(needs.length, 'needs must contain no extras').toBe(laneSet.length);
  });
});
