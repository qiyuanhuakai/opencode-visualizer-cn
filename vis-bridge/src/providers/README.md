# Providers

This directory is reserved for bridge provider adapters.

Expected future contents:

- `codex/`
- `claude/`
- `gemini/`

Each provider should implement the `ProviderModule` interface from `../core/provider` and be responsible for:

- probing availability
- declaring capability support
- creating or resuming provider-backed sessions
- translating provider-native output into normalized bridge events
