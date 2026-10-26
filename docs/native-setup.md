# Native Zen setup

This checkout adds **21 native MCP tools** alongside the original 20 page tools.
It is a local development fork (`1.3.0-local.1`), not an official Zen or upstream
release. It has not been registered in any personal MCP configuration.

### Native tools

| Area | Tools |
|---|---|
| Snapshot | `zen_native_snapshot` |
| Spaces | `zen_spaces_list`, `zen_space_create`, `zen_space_update`, `zen_space_select`, `zen_spaces_reorder`, `zen_space_merge`, `zen_space_delete` |
| Tabs | `zen_tabs_list`, `zen_tab_create`, `zen_tab_pin`, `zen_tab_move` |
| Folders | `zen_folders_list`, `zen_folder_create`, `zen_folder_rename`, `zen_folder_move`, `zen_folder_remove` |
| Splits | `zen_splits_list`, `zen_split_create`, `zen_split_layout`, `zen_split_separate` |

Read IDs from the native list/snapshot tools. Native tab IDs are distinct from
BiDi page indices. `vsep` is side by side, `hsep` is stacked, and `grid` uses
paired columns. Moving or pinning a Split member affects the entire Split.
Space merges preserve the destination's identity, icon and sidebar position.
Use `keepTabs: true` to ungroup a nonempty folder without closing its contents.

### Optional native driver

BiDi operates within webpages; it cannot access Zen's chrome UI. Native tools
use Mozilla's built-in **Marionette** driver in chrome context, in addition to
BiDi. No extension or modified Zen binary is installed. These are privileged
controls: expose the driver only on loopback and only for a profile you
explicitly authorize. Do not launch the personal profile for testing.

The native driver is disabled unless **both** variables are set:

- `ZEN_NATIVE_PORT`: the authorized profile's `marionette.port` (integer).
- `ZEN_NATIVE_PROFILE`: absolute existing path to that exact profile.

The server verifies the real profile path returned by Zen before executing any
native code. It refuses a different profile. Native tools expose fixed
operations, never arbitrary privileged JavaScript. All tool calls are serialized.
Zen allows only one WebDriver session: the server closes the previous driver
session when switching between native and BiDi commands. After switching back
to BiDi, select the desired page again with `zen_select_page`.

Example for an **existing dedicated development profile**, after setting its
`user.js` preference `user_pref("marionette.port", 2839);`:

```sh
/Applications/Zen.app/Contents/MacOS/zen --no-remote \
  --profile /absolute/path/to/development-profile \
  --marionette --remote-allow-system-access --remote-debugging-port 9339
```

Run the server in another terminal:

```sh
ZEN_NATIVE_PORT=2839 \
ZEN_NATIVE_PROFILE=/absolute/path/to/development-profile \
ZEN_DEBUG_PORT=9339 node server.mjs
```

No global npm installation or shell alias is needed. To use from an MCP client,
configure its stdio command as `node` with this checkout's absolute `server.mjs`
path and the three environment variables above. No such configuration is created
by the tests.

### Verification on a fresh isolated profile

```sh
npm ci --ignore-scripts
npm test
npm run test:integration
```

The integration runner creates a **new** profile beneath `.test-runtime/`,
launches the installed Zen headlessly with `--no-remote --profile`, exercises the
MCP interface and native operations, restarts that same process/profile, and
compares the restored spaces, page IDs/URLs/pinned state, folders and Splits.
It stops only its own browser process. It refuses an occupied native test port.
No personal cookies, logins, bookmarks or history are copied. Profiles and logs
are ignored by Git. `ZEN_BINARY` can select another compatible Zen executable.

### Boundaries and compatibility

- Verified against **Zen 1.23.4b / Gecko 158.0.1**, macOS Apple Silicon.
  Zen's internal APIs may change; rerun integration tests after upgrading Zen.
- Space merges/deletes require **one browser window** in the authorized profile.
  Other native operations target that profile's most recent browser window.
- Essentials and live-folder items are readable but protected from tab mutations.
  Live-folder spaces cannot be merged by this implementation.
- Pinned folders accept pinned tabs only. Move a tab/Split out before unpinning.
- Split inputs must have the same space, parent folder and pinned state. Mixed
  states are refused to avoid Zen's implicit duplication behavior.
- Folder nesting respects Zen's configured maximum. The server does not change it.
- Empty-space deletion and nonempty-folder deletion are refused. A fusion is
  not a database transaction: errors can leave already-moved items at their
  destination, but the source is retained if preservation checks fail.
- On a connection loss or timeout, inspect the current state before retrying a
  mutation. Commands are never automatically replayed.
- History/bookmark database import and essential-tab management are outside scope.

Implementation uses the documented [Marionette protocol](https://firefox-source-docs.mozilla.org/remote/marionette/Protocol.html)
and the installed [Zen native APIs](https://github.com/zen-browser/desktop/tree/dev/src/zen).
The behavioral contract is [SPECIFICATION.md](SPECIFICATION.md).
