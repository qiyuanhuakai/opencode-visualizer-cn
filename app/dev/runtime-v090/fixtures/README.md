# Seed 090 capacity fixtures

Generate into an absent, task-owned directory:

```sh
node scripts/qa/runtime-v090-fixtures.mjs generate --count 10000 --out /tmp/vis-seed090-10k
node scripts/qa/runtime-v090-fixtures.mjs check --out /tmp/vis-seed090-10k
```

Use `--count 100000` for stress. Existing directories are refused. Remove only
caller-owned temporary output after retaining the expected inventory and manifest.
No user state, native database, network endpoint, or production scheduler is used.

`seed090.json` is the frozen generation input. `expected.json` is independently
computed from that input, never from emitted rows or a parser's output. It records
source counts, ordered identity hash, boundaries, and total body/attachment bytes.
`manifest.json` hashes every generated data file. `check` streams files, checks
raw row identities/content and per-draft content hashes against the seed, and
rejects missing records, unexpected counts, and changed bytes. Each source has
2,000/20,000 summaries; native IDs intentionally collide across sources. Boundary
rows overlap: every 17th is a child, every 23rd archived, every 29th has no directory;
all timestamps match. OpenCode root counts exceed 1,001; Codex exceeds 51.

The five `.ndjson` wire files contain native list-item shapes, based on the existing
OpenCode worker, Codex protocol, ACP session list, Kimi session, and DSH session
readers. DSH archive membership is a separate workspace classification in the
native protocol, so the canonical summary retains it; it is not invented on the
DSH session wire. These are synthetic protocol inputs, not captured live sessions.
The 200 worktree directories carry canonical path/common-dir/branch metadata;
they are topology fixtures, not real Git checkouts.

There is one unsynced draft for every summary plus one oversized unsynced draft.
Each ordinary draft has 2 KiB body; every 100th has 1 MiB attachment. The extra
draft has a 16 MiB body and a 64 MiB attachment. `drafts.ndjson` identifies byte
ranges and SHA-256 values in `bodies.bin` and `attachments.bin`. Content is generated
and hashed using a single 64 KiB buffer; no full draft map or base64 payload is held
in memory. Verification reads each referenced byte range and proves its hash.

The benchmark runs the unchanged old App through real Chromium. Default: ten
independent cold/warm pairs for local and 100 ms RTT / 20 Mbps network profiles.
It records real first paint, old marks, transfer bytes, post-GC heap, browser-tree
RSS, long tasks, screenshots, Playwright traces, source hashes, and slow/error
connection states. It reports unavailable mixed-source selectable/completion and
Bridge RSS as null with a reason. An empty-renderer trace is not a connected 10k
performance claim or a v0.9 SLO result. The browser/Vite/native-fixture resources
are closed in `finally`, with a lifecycle receipt.
