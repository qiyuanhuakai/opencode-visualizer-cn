# Testing

The default gate is `pnpm test`. Vitest uses `app` as its root, discovers
`**/*.test.ts`, runs in `happy-dom` with forked workers, and keeps the configured
`maxWorkers: 6`. Keep this include and worker count unchanged. To capture the
two machine-readable inputs used by the scenario checker:

```sh
TEST_LIST="$PWD/.omo/evidence/test-suite-organization/after-list.json"
TEST_RUN="$PWD/.omo/evidence/test-suite-organization/after-run.json"
pnpm exec vitest list --json="$TEST_LIST"
pnpm exec vitest run --reporter=json --reporter=hanging-process \
  --outputFile="$TEST_RUN"
```

Run a focused Vitest path when investigating one area. A focused run is useful
diagnosis; it does not replace the full `pnpm test` gate. Browser, native, and
live commands have separate prerequisites described below.

## Test layout and ownership

Tests stay beside the behavior they protect:

| Directory            | Boundary covered                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `app/*.test.ts`      | app, bridge, server, Electron wiring, and root contracts                                         |
| `app/backends/acp`   | ACP protocol, sessions, permissions, and lifecycle                                               |
| `app/backends/codex` | Codex adapters, JSON-RPC, normalization, history, and sockets                                    |
| `app/components`     | mounted Vue components and rendered interaction contracts                                        |
| `app/composables`    | state, transport, subscriptions, and window ownership                                            |
| `app/utils`          | pure utilities and small resource-owning helpers                                                 |
| `app/workers`        | worker protocol, rendering, streaming, and worker teardown                                       |
| `app/locales`        | locale shape, wording, and ACP locale coverage                                                   |
| `app/test`           | shared Electron/main-process test harnesses                                                      |
| `app/dev`            | browser-only QA pages and deterministic browser fixtures; these are not part of Vitest discovery |

Fixtures are local to the boundary that owns them. Examples include
[`acpTestHarness.ts`](../app/backends/acp/acpTestHarness.ts),
[`historyTestHarness.ts`](../app/backends/acp/historyTestHarness.ts),
[`codexTestSocket.ts`](../app/backends/codex/codexTestSocket.ts), the component
and composable `*.test-helpers.ts` modules, and
[`reasoning-sample.ts`](../app/dev/fixtures/reasoning-sample.ts). A fixture may
provide transport or input data, but it must not reproduce the production
algorithm or manufacture the expected business result.

Register every resource as it is acquired and release it in an unconditional
`afterEach` or `finally`, including failure paths. Mounted Vue apps are
unmounted; effect scopes are stopped; workers, sockets, HTTP servers, child
processes, temporary directories, timers, spies, globals, and fake transports
are disposed or restored. Helpers that own a resource return an explicit
`dispose` operation. Cleanup must be idempotent and scoped to resources created
by that test; do not use a global force-exit, broad process kill, blanket
network suppression, or a no-op unsubscribe.

## Scenario inventory and assignments

[`testing-scenario-map.json`](testing-scenario-map.json) is the frozen original
inventory plus its explicit assignment overlay. `baseline` records 300 files
and 2,521 expanded scenarios, including six conditional skips.
`immutableInventory.files`, `immutableInventory.assertionSummaries`, and
`immutableInventory.scenarios` retain every original file hash, old scenario
identity, parameter row, baseline status/skip reason, assertion summary, and
audit classification. Preserve those identity and baseline fields when tests
move. `immutableInventorySha256` makes the original inventory itself
tamper-evident.

`assignments` is separate from that inventory and has exactly one row per
`oldId`. Its disposition, one or more proven destinations, equivalence reason,
and evidence reference describe where the old scenario is now covered.
`current` describes the runnable/conditional current suite and `newTests`
identifies coverage introduced after the baseline; a new test cannot silently
substitute for an unassigned old row. Task lineage fragments and receipts live under
`.omo/evidence/test-suite-organization/` (for example `lineage-*.json`,
`task-N-result.json`, and replacement proof documents). A move, merge, or
replacement needs explicit destinations and a reference to its proof. A merge
must also explain why one destination proves every assigned old behavior. Keep
the old scenario name and parameter occurrence recognizable so a reviewer can
join the assignment to the frozen row. Do not treat a static file count as a
runtime count.

The portable checker validates the ledger against Vitest discovery without
depending on ignored evidence or a reachable baseline Git object. With no
options it performs a live `vitest list` discovery and reports
`checkedRun: false`; that result does not prove the six conditional/skipped
baseline rows. Capture a full run and pass it with `--run` to validate every
current destination and the conditional rows. Because Vitest's configured root
is `app`, use an absolute output path when the report belongs in the checkout's
top-level `.omo` directory:

```sh
node scripts/qa/check-test-scenarios.mjs
TEST_RUN="$PWD/.omo/evidence/test-suite-organization/after-run.json"
pnpm exec vitest run --reporter=json --reporter=hanging-process \
  --outputFile="$TEST_RUN"
node scripts/qa/check-test-scenarios.mjs \
  --run "$TEST_RUN"
```

For a negative ledger check, copy the map or its input into a task-owned
temporary directory, remove one mapping, and require the checker to exit
non-zero. Restore or delete only that temporary copy. Never use a negative
control to mutate the submitted map.

For a behavioral replacement, first save the exact source bytes and SHA-256;
then make one small, explicit defect at the production seam, run the affected
scenario and capture its non-zero exit, diff, stdout, and stderr; restore the
exact bytes and rerun the same scenario to capture exit 0. The proof belongs in
the task evidence directory and the mutation is never submitted. A replacement
without this failed-before/pass-after evidence remains unresolved.

## Entrypoints and boundaries

Task25 adds these package entrypoints:

| Command                | Use and boundary                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:codex`      | Vitest path-filtered Codex adapter/backend suite; still uses the repository Vitest config and is not a second project                  |
| `pnpm qa:codex-popups` | Real App and real popup components in Playwright; only bridge HTTP/WebSocket traffic is routed to a deterministic fixture              |
| `pnpm qa:ui-contracts` | Real mounted UI and styles at the contract runner's 320/768/900/1,440 widths, with geometry, accessibility, and interaction assertions |
| `pnpm test:live:acp`   | Explicit opt-in ACP live suite against a user-provided fixture bridge and session                                                      |

The two browser runners own an exclusive Vite server on `127.0.0.1:5178`, a
fresh browser context, and their evidence directory. They close the page,
context, browser, Vite process group, and port in `finally`; a green assertion
without those lifecycle receipts is incomplete. Install the pinned browser
before running them with `pnpm exec playwright install chromium`.

The existing packaged Electron entries (`pnpm qa:electron`,
`pnpm qa:electron-desktop`, and `pnpm qa:electron-storage`) require an unpacked
packaged executable in `VIS_ELECTRON_EXECUTABLE`; package it with
`pnpm electron:preview` first. They use an isolated temporary user-data
profile, keep Chromium sandboxing enabled, write a receipt and screenshot, and
close the app in all outcomes. Native desktop/editor layout support starts at
900px content width. The Task24 browser observation at 320px is retained as a
known limitation: the connected ProviderManager row has a tall action area and
the second row extends below the initial frame. The production component was
byte-identical to the baseline, so this pre-existing ProviderManager 320px
tall-action limitation is preserved, recorded, and out of scope for Task25.

The live ACP suite is never implied by a normal test run. Without
`ACP_LIVE_QA`, its existing scenarios remain skipped. With a bridge URL, provide
all seven dedicated fixture values `ACP_LIVE_QA_CWD`, `ACP_LIVE_QA_SESSION_ID`,
`ACP_LIVE_QA_EXPECTED_MODEL`, `ACP_LIVE_QA_EXPECTED_AGENT`,
`ACP_LIVE_QA_EXPECTED_UPDATED_AT`, `ACP_LIVE_QA_TARGET_MODEL`, and
`ACP_LIVE_QA_TARGET_MODE`; a bridge URL without these values must fail fast.
The runner reads and synchronizes only the named fixture session, saves its
original model and mode, and restores them in `finally`. It never deletes a
user session, chooses one at random, or sends a paid model prompt. A configured
entrypoint proves configuration only until a real authorized fixture run has
produced its own receipt.

## Pre-Task25 QA scripts

The following 17 files are the pre-Task25 inventory. Task25 additions such as
`check-test-scenarios.mjs`, `test-scenario-vitest.mjs`, `codex-popups.mjs`,
`test-contracts-support.mjs`, and `ui-contracts.mjs` plus its helper directory
are intentionally excluded from this table.

| Script and invocation                                                                                          | Prerequisites                                                                                                                          | Purpose                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/qa/build-artifact-check.mjs [--no-build] [--report FILE]`                                        | Node/pnpm dependencies, `artifact-budget.json`; a production `dist` is built unless `--no-build` is used                               | Check relative asset URLs, referenced files, frozen per-asset caps, and total asset budget                                               |
| `node scripts/qa/codex-auxiliary-storage.mjs`                                                                  | Vite app at `VIS_QA_URL` (default `http://127.0.0.1:5173`), Playwright Chromium                                                        | Exercise browser storage quota migration, effort metadata, recovery, flush, and cross-tab synchronization                                |
| `node scripts/qa/electron-desktop.mjs`                                                                         | Packaged executable in `VIS_ELECTRON_EXECUTABLE`; native Electron/Playwright; optional `VIS_DESKTOP_QA_SERVER` for connected update UI | Exercise desktop preferences, menu, tray, update rows, locale, and cleanup                                                               |
| `bash scripts/qa/electron-installer-unix.sh --platform <linux\|macos> --arch <x64\|arm64> --artifacts-dir DIR` | Matching native runner; Linux `dpkg-deb`/AppImage extraction, or macOS `hdiutil`/`codesign`/archive tools; packaged artifacts          | Install/extract both Unix artifact forms, run the Electron smoke surface, and verify native arch and process cleanup                     |
| `./scripts/qa/electron-installer-windows.ps1 -Arch <x64\|arm64>`                                               | Windows runner, matching `dist-electron/Vis-*-<arch>-Windows.exe`, PowerShell                                                          | Silent per-user NSIS install, smoke, bounded process cleanup, uninstall, and residue check                                               |
| `node scripts/qa/electron-persistent-storage-sync.mjs`                                                         | Packaged executable in `VIS_ELECTRON_EXECUTABLE`, Playwright, native sandbox support                                                   | Verify malformed renderer storage preservation and same-process recovery across reloads                                                  |
| `scripts/qa/electron-smoke-utils.mjs`                                                                          | Imported by Electron smoke drivers                                                                                                     | Shared preload schema, runtime state, bounded close, process, and cleanup helpers; no standalone gate                                    |
| `node scripts/qa/electron-smoke.mjs`                                                                           | `VIS_ELECTRON_EXECUTABLE` from `pnpm electron:preview`; Playwright and a native sandbox-capable runtime                                | Verify packaged `app://index.html`, preload API, storage/clipboard round trips, sandbox, window policy, console, receipt, and clean quit |
| `node scripts/qa/ensure-production-dist.mjs [--cwd DIR]`                                                       | Node/pnpm build dependencies and writable build/cache paths                                                                            | Serialize and recover a real production `dist` build for dist-dependent gates                                                            |
| `node scripts/qa/node-pty-dual-runtime.mjs [--runtimes node,sea,electron ...]`                                 | `node-pty`, platform shell (`bash` on POSIX or Windows shell), built `vis_bridge` for `sea`, Electron runtime for `electron`           | Prove PTY sentinel output, resize, kill, and child-tree cleanup in Node, SEA, and Electron runtimes                                      |
| `node scripts/qa/pty-runtime-probe.mjs MODULE_DIR RECEIPT_PATH WORK_DIR`                                       | Invoked by the dual-runtime driver with a staged `node-pty` module and absolute work directory                                         | Internal probe for one runtime's shell, resize, kill, and no-survivor assertions                                                         |
| `node scripts/qa/stream-bench.mjs [--scenario markdown] [BASE_URL]`                                            | Vite dev server, pinned Playwright Chromium, `app/dev` benchmark pages and fixtures                                                    | Benchmark legacy versus streaming code/markdown rendering and write raw plus aggregate metrics                                           |
| `node scripts/qa/stream-driver-check.mjs [BASE_URL]`                                                           | Vite dev server (`STREAM_QA_URL` or argument), pinned Playwright Chromium                                                              | Check real CodeRenderer streaming, gutter continuity, theme switch, cancellation, and restored deliberate failure                        |
| `node scripts/qa/stream-md-check.mjs [BASE_URL]`                                                               | Vite dev server (`STREAM_QA_URL` or argument), pinned Playwright Chromium                                                              | Check real Markdown/Reasoning streaming stable-prefix, fence commit, convergence, theme, shrink, and cancellation behavior               |
| `node scripts/qa/vis-bridge-installer-daemon-qa.mjs ACTION STATE_DIR PORT EVIDENCE`                            | Running `vis_bridge` daemon and a task-owned state/evidence directory                                                                  | Internal HTTP helper for spawning, killing, and proving daemon child ownership during installer lifecycle tests                          |
| `./scripts/qa/vis-bridge-installer-windows.ps1`                                                                | Windows runner, matching native installer under `dist-bridge/installers`, PowerShell                                                   | Install, exercise, reinstall, uninstall, and verify daemon lifecycle and user PATH registration                                          |
| `sh scripts/qa/vis-bridge-rpm-lifecycle.sh --container RELEASE_RPM`                                            | Disposable Linux container with Node, `dnf`, `rpm`, `rpm-build`, `vis_bridge`, and the helper mounted at `/workspace`                  | Verify normal RPM install, upgrade, daemon stop/restart ownership, and uninstall lifecycle                                               |

`electron-smoke-utils.mjs`, `pty-runtime-probe.mjs`, and
`vis-bridge-installer-daemon-qa.mjs` are support modules. Run them through
their parent driver so the parent owns the process and cleanup receipts.

## Native environment notes

Native checks are platform-specific evidence. A Linux packaged Electron run
uses a disposable `node:24-bookworm` x64 environment with `git`, `xvfb`,
`xauth`, and the Chromium/Electron libraries (`libgtk-3-0`, `libnss3`,
`libxss1`, `libasound2`, `libgbm1`, `libatk-bridge2.0-0`, `libcups2`,
`libdrm2`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxfixes3`,
`libxrandr2`, `libatspi2.0-0`, and `libnotify4`). Keep the source mount
read-only, provide a writable copied work tree and top-level dependency links,
set the packaged `chrome-sandbox` owner/mode to `root:root`/`4755`, and keep
`chromiumSandbox: true`. Use `--rm`, `--shm-size=1g`, and the container-only
namespace capability required by Chromium; do not weaken the sandbox or change
host security settings.

For the RPM integration lane, use the same absolute worktree path when the
checkout has a linked `.git`, install `rpm`, `cpio`, and `rpm2cpio` only inside
the disposable environment, and run the test as the unprivileged container
user. Record the unique container name before launch and verify no matching
container or task-owned profile remains afterward. The reusable environment
recipe and its receipts are documented in
[`task-22/native-environment.md`](../.omo/evidence/test-suite-organization/task-22/native-environment.md)
and [`native-environment.md`](../.omo/evidence/test-suite-organization/native-environment.md).

These prerequisites define when a lane can run; they do not claim that any
unavailable platform, live ACP service, or real model has been executed.
