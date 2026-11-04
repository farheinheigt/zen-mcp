# Zen MCP

Control Zen Browser from an MCP client.

Fork of [sh6drack/zen-mcp](https://github.com/sh6drack/zen-mcp), keeping the original **20 web tools** and adding native organization tools plus guarded XPI management.

## What it does

- **Spaces:** create, rename, select, reorder and merge.
- **Folders:** create, rename, nest, move and ungroup without closing tabs.
- **Pinned tabs:** pin, unpin and move between spaces or folders.
- **Splits:** create views with 2–4 tabs, change layout and separate them.
- **Web pages:** read, navigate, click, fill forms and take screenshots.
- **Extensions:** install/update and verify XPI files through Gecko RDP, with explicit profile, ID, version and SHA-256 checks.

## Install

Requires Node.js 20+ and Zen Browser.

```sh
git clone https://github.com/farheinheigt/zen-mcp.git
cd zen-mcp
npm ci --ignore-scripts
```

For web tools, launch Zen with `--remote-debugging-port 9222`, then configure your MCP client to run:

```sh
node /absolute/path/to/zen-mcp/server.mjs
```

Organization tools additionally require Marionette and an explicitly authorized profile. XPI tools use a separate Gecko RDP endpoint and an explicitly authorized profile; a dedicated profile is recommended for testing unsigned packages. See [setup instructions](docs/native-setup.md).

The XPI tool contract and profile checks are documented in [the RDP setup guide](docs/native-setup.md). The bridge verifies the XPI SHA-256 and manifest ID/version, then confirms the installed extension is active, permanent, and matches the expected hash. It never changes signature preferences or restarts Zen. Unsigned installation succeeds only when the profile's own Gecko policy permits it. The original web tools remain BiDi and organization tools remain Marionette; neither transport is enabled implicitly by XPI operations.

## Test safely

```sh
npm test
npm run test:integration
```

Integration tests create a separate Zen profile, run headlessly, verify the result after a restart, then stop the test browser. They do not use your personal session. The default binary path is for macOS; set `ZEN_BINARY` to override it.

## Limits

Tested with Zen **1.23.4b / Gecko 158.0.1** on macOS Apple Silicon. Native APIs may change between Zen versions.

Space merges/deletions require a single browser window. Essentials and live-folder items are protected. Native tools are disabled unless a profile and port are explicitly configured.

This fork is installed from source; it is not published on npm.

MIT, following the upstream project.
