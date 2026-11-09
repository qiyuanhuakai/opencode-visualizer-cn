const { version } = require('electron/package.json');
const checksums = require('electron/checksums.json');

// Use the manifest shipped in the lockfile-verified official Electron package,
// as Electron's own install.js does. Keep archive SHA-256 validation enabled
// without a second network dependency on the release's SHASUMS256.txt.
for (const target of ['darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64', 'linux-x64']) {
  const filename = `electron-v${version}-${target}.zip`;
  if (!/^[a-f0-9]{64}$/u.test(checksums[filename] ?? '')) {
    throw new Error(`Missing official Electron checksum: ${filename}`);
  }
}

module.exports = {
  electronDownload: {
    // Select electron-builder's modern @electron/get option path.
    mirrorOptions: {},
    checksums,
  },
};
