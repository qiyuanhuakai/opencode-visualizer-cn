import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { isNewerVersion, selectBridgeAsset, sha256FromDigest } from '../electron/updatePolicy.js';
import { createUpdateTransport } from '../electron/updateTransport.js';
import { createInstallerHandoff } from './updateHandoff.js';
import { assertBridgeInstallAllowed, detectLinuxPackageFormat } from './updatePlatform.js';

export function parseBridgeUpdateArgs(argv = process.argv.slice(2)) {
  if (argv[0] !== 'update' && argv[0] !== 'upgrade') return null;
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      check: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      yes: { type: 'boolean', short: 'y' },
    },
    allowPositionals: false,
    strict: true,
  });
  return {
    command: 'update',
    check: Boolean(values.check),
    help: Boolean(values.help),
    yes: Boolean(values.yes),
  };
}

export function updateUsage() {
  return `Usage:
  vis_bridge update [--check] [--yes|-y]
  vis_bridge upgrade [--check] [--yes|-y]

Options:
  --check              Check the latest stable release without downloading or installing.
  --yes, -y            Confirm an available update without prompting.
  --help, -h           Show this help.`;
}

export async function runBridgeUpdate(options, injected = {}) {
  const dependencies = createDependencies(injected);
  let stagedPath = null;
  let handedOff = false;
  try {
    dependencies.output('Checking the latest stable vis_bridge release...');
    const release = await dependencies.transport.getLatestRelease();
    const result = {
      currentVersion: dependencies.currentVersion,
      latestVersion: release.version,
    };
    if (!isNewerVersion(release.version, dependencies.currentVersion)) {
      dependencies.output(`vis_bridge ${dependencies.currentVersion} is current; latest stable is ${release.version}.`);
      return { kind: 'current', ...result };
    }
    const previewLinuxFormat = await resolveLinuxFormat(dependencies, false);
    const previewAsset = selectBridgeAsset(
      release,
      dependencies.platform,
      dependencies.arch,
      previewLinuxFormat,
    );
    sha256FromDigest(previewAsset);
    dependencies.presentOffer({
      currentVersion: dependencies.currentVersion,
      latestVersion: release.version,
      asset: previewAsset,
    });
    if (options.check) {
      return { kind: 'available', ...result };
    }
    if (!options.yes) {
      if (!dependencies.interactive) {
        throw new Error('An update is available; rerun with --yes in a non-interactive terminal.');
      }
      const approved = await dependencies.confirm(
        `Updating interrupts all connected clients and running tasks. Continue? [y/N] `,
      );
      if (!approved) {
        dependencies.output('Update cancelled.');
        return { kind: 'cancelled', ...result };
      }
    }

    await dependencies.assertInstallAllowed({
      allowPrivilegedInspection: true,
      nonInteractiveYes: options.yes && !dependencies.interactive,
    });
    const linuxFormat = await resolveLinuxFormat(dependencies, true);
    const asset = selectBridgeAsset(release, dependencies.platform, dependencies.arch, linuxFormat);
    const digest = sha256FromDigest(asset);
    dependencies.output(`Downloading ${asset.name} (${asset.size} bytes)...`);
    stagedPath = await dependencies.transport.downloadAsset(asset, () => undefined);
    await dependencies.transport.verifyAsset(stagedPath, asset, digest, 'sha256');
    await dependencies.handoff({
      assetPath: stagedPath,
      linuxFormat,
      nonInteractiveYes: options.yes && !dependencies.interactive,
      onAccepted: (resultLogPath) => dependencies.output(resultLogPath
        ? `Installer handoff accepted; the installer result will be written to ${resultLogPath}.`
        : 'Installer handoff accepted; installation continues after vis_bridge exits.'),
    });
    handedOff = true;
    return { kind: 'handed-off', ...result };
  } catch (error) {
    if (stagedPath && !handedOff) await dependencies.transport.removeFile?.(stagedPath);
    throw error;
  } finally {
    dependencies.transport.dispose();
  }
}

function createDependencies(injected) {
  const transport = injected.transport ?? createUpdateTransport();
  const output = injected.output ?? ((message) => console.log(message));
  return {
    currentVersion: injected.currentVersion,
    platform: injected.platform ?? process.platform,
    arch: injected.arch ?? process.arch,
    interactive: injected.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    output,
    presentOffer: injected.presentOffer ?? ((offer) => output(
      `Update available: ${offer.currentVersion} -> ${offer.latestVersion} (${offer.asset.name}, ${offer.asset.size} bytes).`,
    )),
    confirm: injected.confirm ?? confirmUpdate,
    assertInstallAllowed: injected.assertInstallAllowed ?? ((options) => assertBridgeInstallAllowed(options)),
    resolveLinuxFormat: injected.resolveLinuxFormat ?? detectLinuxPackageFormat,
    handoff: injected.handoff ?? createInstallerHandoff(),
    transport,
  };
}

function resolveLinuxFormat(dependencies, requireOwnership) {
  return dependencies.platform === 'linux'
    ? dependencies.resolveLinuxFormat({ requireOwnership })
    : Promise.resolve(null);
}

async function confirmUpdate(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    prompt.close();
  }
}
