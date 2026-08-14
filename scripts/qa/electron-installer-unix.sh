#!/usr/bin/env bash
# Electron installer QA for the Linux and macOS lanes (Scenario S5/S6).
#
# Linux  (--platform linux): installs the .deb with `apt-get` and launches the
#   installed executable with an isolated userData profile; then extracts the
#   AppImage with `--appimage-extract` and launches the extracted binary — the
#   extract-and-run path deliberately avoids FUSE, covering FUSE-less hosts.
# macOS  (--platform macos): mounts the .dmg, verifies the ad-hoc signature with
#   `codesign --verify --deep --strict` and `codesign -dv` (Signature=adhoc, no
#   TeamIdentifier), launches the app from the mount; then unzips the .zip and
#   repeats signature verification and launch. BOTH artifacts must pass — never
#   one or the other. Runs on real macOS runners only (hdiutil, no xvfb).
#
# Every launch goes through scripts/qa/electron-smoke.mjs with an isolated
# `--user-data-dir`; the driver asserts app://index.html, Chromium sandbox,
# storage/clipboard round-trips, and a clean quit, then the script confirms the
# receipt reported this lane's native arch and that no app process remains.
#
# Usage:
#   electron-installer-unix.sh --platform <linux|macos> --arch <x64|arm64> \
#     --artifacts-dir <dist-electron> [--smoke-out-dir <dir>] \
#     [--executable-name <vis>]
#
# Constrained-host override (never set on CI runners):
#   VIS_QA_DEB_INSTALL_ROOT=<dir>  extract the deb with `dpkg-deb -x` into <dir>
#     and launch the installed layout from there instead of a system-wide
#     `sudo apt-get install` (e.g. a dev box without passwordless sudo). CI lanes use
#     the real system install.
set -euo pipefail

PLATFORM=""
ARCH=""
ARTIFACTS_DIR=""
SMOKE_OUT_DIR=""
EXECUTABLE_NAME="vis"

die() {
  echo "ELECTRON-INSTALLER-QA FAIL: $*" >&2
  exit 1
}

usage() {
  echo "usage: electron-installer-unix.sh --platform <linux|macos> --arch <x64|arm64> --artifacts-dir <dir> [--smoke-out-dir <dir>] [--executable-name <name>]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --artifacts-dir) ARTIFACTS_DIR="$2"; shift 2 ;;
    --smoke-out-dir) SMOKE_OUT_DIR="$2"; shift 2 ;;
    --executable-name) EXECUTABLE_NAME="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$PLATFORM" == "linux" || "$PLATFORM" == "macos" ]] || usage
[[ "$ARCH" == "x64" || "$ARCH" == "arm64" ]] || die "unsupported arch '$ARCH' (expected x64|arm64)"
[[ -d "$ARTIFACTS_DIR" ]] || die "artifacts dir '$ARTIFACTS_DIR' does not exist"
ARTIFACTS_DIR="$(cd "$ARTIFACTS_DIR" && pwd)"

case "$PLATFORM" in
  linux) EXPECTED_NODE_PLATFORM="linux" ;;
  macos) EXPECTED_NODE_PLATFORM="darwin" ;;
esac

SMOKE_OUT_DIR="${SMOKE_OUT_DIR:-${RUNNER_TEMP:-/tmp}/smoke-installer-$PLATFORM-$ARCH}"

# Teardown state, populated as artifacts are acquired.
WORK_DIRS=()        # temp dirs to remove on exit
DMG_DEVICE=""       # mounted dmg device to detach on exit
LAUNCHED_EXES=()    # executable paths launched, for the leftover-process sweep
DEB_PKG_NAME=""     # deb package installed system-wide (uninstalled on exit)
DEB_INSTALL_ATTEMPTED=0
DEB_PREEXISTED=0

# PID-based sweep of processes whose cmdline contains the executable path
# (never pkill/pgrep -f: a -f pattern present in the invoking wrapper's own
# command line kills the wrapper — issues.md rule; kill by PID only). The
# match runs in the shell, so no helper process carries the pattern in its
# own cmdline.
launched_pids() {
  local exe="$1" pid args
  ps -eo pid=,args= |
    while read -r pid args; do
      if [[ -n "$pid" && "$args" == *"$exe"* ]]; then
        echo "$pid"
      fi
    done
}

kill_launched_exes() {
  local exe pid i
  for exe in "${LAUNCHED_EXES[@]-}"; do
    [[ -n "$exe" ]] || continue
    # Two passes: after SIGKILL of the main process, Chromium helpers may
    # linger briefly; a second sweep catches them.
    for i in 1 2; do
      while read -r pid; do
        kill -9 "$pid" 2>/dev/null || true
      done < <(launched_pids "$exe")
      if [[ $i -eq 1 ]]; then
        sleep 0.2
      fi
    done
  done
}

# Best-effort uninstall of the system-installed .deb, gated on non-interactive
# sudo so a dev box without passwordless sudo gets a clear message instead of
# a hung prompt.
uninstall_system_deb() {
  if [[ "$DEB_INSTALL_ATTEMPTED" != "1" || -z "$DEB_PKG_NAME" ]]; then
    return
  fi
  if [[ "$DEB_PREEXISTED" == "1" ]]; then
    echo "cleanup: $DEB_PKG_NAME predated this QA run — leaving it installed" >&2
    return
  fi
  if ! dpkg-query -W -f='${db:Status-Abbrev}' "$DEB_PKG_NAME" 2>/dev/null | grep -q '^ii '; then
    return
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    echo "cleanup: sudo not found — leaving system .deb installed (remove manually: sudo dpkg -r $DEB_PKG_NAME)" >&2
    return
  fi
  if ! sudo -n true 2>/dev/null; then
    echo "cleanup: non-interactive sudo unavailable — leaving system .deb installed (remove manually: sudo dpkg -r $DEB_PKG_NAME)" >&2
    return
  fi
  echo "cleanup: uninstalling system .deb ($DEB_PKG_NAME, best-effort)"
  sudo -n dpkg -r "$DEB_PKG_NAME" >/dev/null 2>&1 ||
    echo "cleanup: dpkg -r $DEB_PKG_NAME failed (best-effort)" >&2
}

cleanup() {
  kill_launched_exes
  if [[ -n "$DMG_DEVICE" ]]; then
    hdiutil detach "$DMG_DEVICE" -quiet || true
  fi
  uninstall_system_deb
  local dir
  for dir in "${WORK_DIRS[@]-}"; do
    [[ -n "$dir" ]] || continue
    rm -rf "$dir"
  done
}
trap cleanup EXIT

# run_smoke <name> <executable> — launch through the smoke driver with an
# isolated profile; the driver's own watchdog bounds the launch, and `timeout`
# wraps it when available so a hung node cannot stall the lane. Receipts land
# in <smoke-out-dir>/<name>/ so each installer keeps its own evidence.
run_smoke() {
  local name="$1"
  local exe="$2"
  # Register BEFORE launching: the exit trap must be able to sweep this
  # executable even when the smoke driver dies mid-launch (watchdog kill,
  # assertion failure before its own quit).
  LAUNCHED_EXES+=("$exe")
  export VIS_ELECTRON_EXECUTABLE="$exe"
  export VIS_SMOKE_OUT_DIR="$SMOKE_OUT_DIR/$name"
  mkdir -p "$VIS_SMOKE_OUT_DIR"
  if command -v timeout >/dev/null 2>&1; then
    if [[ "$PLATFORM" == "linux" ]]; then
      timeout --signal=TERM --kill-after=30s 300s xvfb-run -a node scripts/qa/electron-smoke.mjs
    else
      timeout --signal=TERM --kill-after=30s 300s node scripts/qa/electron-smoke.mjs
    fi
  else
    if [[ "$PLATFORM" == "linux" ]]; then
      xvfb-run -a node scripts/qa/electron-smoke.mjs
    else
      node scripts/qa/electron-smoke.mjs
    fi
  fi
  node -e "
    const r = require(process.env.VIS_SMOKE_OUT_DIR + '/receipt.json');
    if (r.platform.platform !== '$EXPECTED_NODE_PLATFORM' || r.platform.arch !== '$ARCH') {
      console.error('receipt reports ' + r.platform.platform + '/' + r.platform.arch + ', expected $EXPECTED_NODE_PLATFORM/$ARCH');
      process.exit(1);
    }
  " || die "smoke receipt arch/platform mismatch"
  if [[ -n "$(launched_pids "$exe")" ]]; then
    die "app still running after smoke quit: $exe"
  fi
}

# verify_mac_signature <Vis.app> — unsigned-but-adhoc contract: strict deep
# verify passes, Signature=adhoc, and there is NO TeamIdentifier.
verify_mac_signature() {
  local app="$1"
  codesign --verify --deep --strict "$app" || die "codesign --verify --deep --strict failed for $app"
  local info
  info="$(codesign -dv "$app" 2>&1 || true)"
  echo "$info" | grep -q 'Signature=adhoc' || die "expected Signature=adhoc for $app"
  if echo "$info" | grep -q 'TeamIdentifier='; then
    die "unexpected TeamIdentifier in ad-hoc signature of $app"
  fi
  echo "codesign OK (adhoc, no TeamIdentifier): $app"
}

if [[ "$PLATFORM" == "linux" ]]; then
  # deb and AppImage use format-native arch tokens (amd64 / x86_64), unlike
  # dmg/zip/exe which keep x64 / arm64.
  case "$ARCH" in
    x64) DEB_ARCH="amd64"; APPIMAGE_ARCH="x86_64" ;;
    arm64) DEB_ARCH="arm64"; APPIMAGE_ARCH="aarch64" ;;
  esac
  # Newest-by-mtime first: a lane's dist-electron may hold stale artifacts from
  # earlier runs (e.g. the pre-upgrade Electron-35 build) that must not shadow
  # the freshly built installers.
  deb="$(ls -t "$ARTIFACTS_DIR"/Vis-*-"$DEB_ARCH"-Linux.deb 2>/dev/null | head -1 || true)"
  [[ -f "$deb" ]] || die "no Vis-*-$DEB_ARCH-Linux.deb found in $ARTIFACTS_DIR"
  echo "== linux deb QA: $deb =="
  dpkg_arch="$(dpkg-deb -f "$deb" Architecture)"
  [[ "$dpkg_arch" == "$DEB_ARCH" ]] || die "deb declares Architecture '$dpkg_arch', expected $DEB_ARCH"

  if [[ -n "${VIS_QA_DEB_INSTALL_ROOT:-}" ]]; then
    # Constrained-host mode (documented in the header): extract-and-run of the
    # installed layout. CI lanes never set this variable and use `sudo apt-get install`.
    DEB_PARENT="$VIS_QA_DEB_INSTALL_ROOT"
    [[ -d "$DEB_PARENT" ]] || die "deb install root '$DEB_PARENT' does not exist"
    DEB_ROOT="$(mktemp -d "${DEB_PARENT%/}/vis-deb-qa-XXXXXX")"
    dpkg-deb -x "$deb" "$DEB_ROOT"
    WORK_DIRS+=("$DEB_ROOT")
    INSTALLED_EXE="$DEB_ROOT/opt/Vis/$EXECUTABLE_NAME"
    echo "note: system-wide dpkg install skipped (VIS_QA_DEB_INSTALL_ROOT set); verifying installed layout at $INSTALLED_EXE"
  else
    DEB_PKG_NAME="$(dpkg-deb -f "$deb" Package)"
    if dpkg-query -W -f='${db:Status-Abbrev}' "$DEB_PKG_NAME" 2>/dev/null | grep -q '^ii '; then
      DEB_PREEXISTED=1
    fi
    DEB_INSTALL_ATTEMPTED=1
    sudo apt-get install -y "$deb"
    INSTALLED_EXE="/opt/Vis/$EXECUTABLE_NAME"
  fi
  [[ -x "$INSTALLED_EXE" ]] || die "installed executable missing: $INSTALLED_EXE"
  run_smoke "deb" "$INSTALLED_EXE"

  appimage="$(ls -t "$ARTIFACTS_DIR"/Vis-*-"$APPIMAGE_ARCH"-Linux.AppImage 2>/dev/null | head -1 || true)"
  [[ -f "$appimage" ]] || die "no Vis-*-$APPIMAGE_ARCH-Linux.AppImage found in $ARTIFACTS_DIR"
  echo "== linux AppImage extract-and-run QA: $appimage =="
  chmod +x "$appimage"
  EXTRACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vis-appimage-qa-XXXXXX")"
  WORK_DIRS+=("$EXTRACT_DIR")
  (cd "$EXTRACT_DIR" && "$ARTIFACTS_DIR/$(basename "$appimage")" --appimage-extract)
  EXTRACTED_EXE="$EXTRACT_DIR/squashfs-root/$EXECUTABLE_NAME"
  [[ -x "$EXTRACTED_EXE" ]] || die "extracted executable missing: $EXTRACTED_EXE"
  run_smoke "appimage" "$EXTRACTED_EXE"
  echo "AppImage extract-and-run OK (no FUSE required)"

else # macOS — both DMG and ZIP must launch; never one or the other.
  dmg="$(ls -t "$ARTIFACTS_DIR"/Vis-*-"$ARCH"-MacOS.dmg 2>/dev/null | head -1 || true)"
  zip="$(ls -t "$ARTIFACTS_DIR"/Vis-*-"$ARCH"-MacOS.zip 2>/dev/null | head -1 || true)"
  [[ -f "$dmg" ]] || die "no Vis-*-$ARCH-MacOS.dmg found in $ARTIFACTS_DIR"
  [[ -f "$zip" ]] || die "no Vis-*-$ARCH-MacOS.zip found in $ARTIFACTS_DIR"

  echo "== macos dmg QA: $dmg =="
  ATTACH_OUT="$(hdiutil attach -nobrowse "$dmg")"
  DMG_DEVICE="$(echo "$ATTACH_OUT" | tail -1 | awk -F '\t' '{print $1}')"
  MOUNT_POINT="$(echo "$ATTACH_OUT" | tail -1 | awk -F '\t' '{print $NF}')"
  [[ -n "$DMG_DEVICE" && -n "$MOUNT_POINT" ]] || die "hdiutil attach failed for $dmg"
  DMG_APP="$MOUNT_POINT/Vis.app"
  [[ -d "$DMG_APP" ]] || die "Vis.app missing on mounted volume: $MOUNT_POINT"
  verify_mac_signature "$DMG_APP"
  run_smoke "dmg" "$DMG_APP/Contents/MacOS/Vis"
  hdiutil detach "$DMG_DEVICE" -quiet || true
  DMG_DEVICE=""

  echo "== macos zip QA: $zip =="
  ZIP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vis-zip-qa-XXXXXX")"
  WORK_DIRS+=("$ZIP_DIR")
  unzip -q "$zip" -d "$ZIP_DIR"
  ZIP_APP="$ZIP_DIR/Vis.app"
  [[ -d "$ZIP_APP" ]] || die "Vis.app missing after unzip of $zip"
  verify_mac_signature "$ZIP_APP"
  run_smoke "zip" "$ZIP_APP/Contents/MacOS/Vis"
fi

echo "ELECTRON-INSTALLER-QA PASS ($PLATFORM/$ARCH)"
