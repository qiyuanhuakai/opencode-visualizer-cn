# Plugins

This directory is reserved for bridge-side plugin adapters.

These are not meant to be an unrestricted plugin marketplace in the first phase.
The initial purpose is controlled, on-demand integration for optional capabilities such as:

- context enrichers
- command helpers
- metrics collectors
- status extensions

Each plugin should implement the `PluginModule` interface from `../core/plugin`.
