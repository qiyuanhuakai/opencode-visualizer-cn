# vis-bridge

This directory is the initial skeleton for the planned local bridge server described in `RoadMap.md` and `Future.md`.

It is intentionally **not wired into the current app build yet**.
The goal of this skeleton is to provide:

- a stable place for future bridge code
- shared TypeScript contracts for bridge API and events
- clear separation between provider adapters, plugin adapters, and bridge core interfaces

## Proposed Layout

```text
vis-bridge/
├── README.md
├── tsconfig.json
└── src/
    ├── index.ts
    ├── contracts/
    │   ├── api.ts
    │   ├── events.ts
    │   └── models.ts
    ├── core/
    │   ├── plugin.ts
    │   ├── provider.ts
    │   └── session.ts
    ├── plugins/
    │   └── README.md
    └── providers/
        └── README.md
```

## Current Scope

The files in this skeleton define **interfaces only**.

They are meant to guide implementation of:

- provider probing and capability reporting
- bridge session lifecycle management
- normalized event streaming
- plugin discovery and on-demand activation

## Deliberate Non-Goals for This Skeleton

- No runtime implementation yet
- No provider binaries are invoked here yet
- No integration with the existing frontend build yet
- No plugin marketplace or dynamic remote loading

## Next Suggested Steps

1. Implement a minimal `codex` provider under `src/providers/`
2. Implement a simple in-memory session store conforming to `src/core/session.ts`
3. Expose a draft HTTP/SSE server using the contracts in `src/contracts/`
