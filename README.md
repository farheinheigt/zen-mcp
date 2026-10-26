# Zen MCP

Control Zen Browser from an MCP client.

Fork of [sh6drack/zen-mcp](https://github.com/sh6drack/zen-mcp), adding **21 native tools** alongside the original **20 web tools**.

## What it does

- **Spaces:** create, rename, select, reorder and merge.
- **Folders:** create, rename, nest, move and ungroup without closing tabs.
- **Pinned tabs:** pin, unpin and move between spaces or folders.
- **Splits:** create views with 2–4 tabs, change layout and separate them.
- **Web pages:** read, navigate, click, fill forms and take screenshots.

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

Native tools additionally require Marionette and an explicitly authorized profile. See [setup instructions](docs/native-setup.md).

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
