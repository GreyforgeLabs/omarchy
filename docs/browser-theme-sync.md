# Browser Theme Sync

Omarchy Theme Sync exposes the current desktop palette to websites through CSS variables and `window.omarchy`. Websites choose whether to use these values; the extension does not automatically restyle every site or change Chromium's toolbar theme.

The runtime and regression fixtures are adapted from [omacom/omarchy-theme-sync](https://github.com/omacom/omarchy-theme-sync), including its multi-background and theme-asset API. The upstream MIT notice is retained in `default/chromium/extensions/theme-sync/LICENSE`. The square icon is an [official Omarchy brand asset](https://omarchy.org/brand), not a grant of trademark rights. No private signing key is included or required.

## How It Works

```text
Omarchy current theme
  -> native helper watches current state
  -> extension service worker caches and broadcasts the palette
  -> content scripts write CSS variables and attributes
  -> websites read the DOM or window.omarchy
```

`bin/omarchy-browser-theme-host` watches `~/.local/state/omarchy/current/`, including replacement of the `theme` directory. It sends length-prefixed JSON through Chromium native messaging. The bundled host uses the Omarchy session's `OMARCHY_PATH` environment, rather than the standalone project's path-discovery logic.

The isolated content script receives palette messages and writes properties on `<html>`. A main-world script exposes `window.omarchy`, which reads those live properties. Page requests cross the isolated bridge to the worker; only the worker can authorize the browser-provided origin and frame identity. The helper independently validates requests before writing or invoking Omarchy.

The extension has a stable public manifest key and ID, `ppnnomfimbfcofidkfmghapellfbgklc`. Native manifests permit only that extension origin and use the name `com.omarchy.theme`. The bundled worker is `background-1.js`; version its filename when changing the bundled worker so an older registered service worker cannot hide the update.

## Installation and Upgrades

- Fresh user provisioning registers the helper through `install/user/chromium.sh`; this does not depend on pending migrations or an existing Chromium profile.
- The default Chromium flags include `default/chromium/extensions/theme-sync`. Runtime setup uses the selected `OMARCHY_PATH` for source checkouts and packaged installs.
- An upgrade migration invokes `omarchy-install-chromium-theme-sync`. It preserves custom flags, unrelated extensions, symlinked dotfiles, and an unterminated final line. It does not run a destructive refresh or restart the browser.
- Later browser installation and explicit Chromium refresh also register the helper. Branded Chromium browsers still need to support unpacked extension loading; native registration alone does not bypass their restrictions.
- Updating the existing runtime/settings packages supplies these files through their normal `bin/`, `default/`, and `config/` packaging rules. No separate theme-sync package, repository clone, system daemon, root policy, or new sudo permission is needed.

Restart the browser after installation or migration. If manually reloading the extension, reload open pages too so their content scripts reconnect.

The installer replaces standalone entries only when their readable manifest public key identifies the same extension. It also handles the exact packaged theme-sync path when selecting a source checkout. It does not delete standalone files or infer identity from directory/display names. Missing or malformed manifests are preserved for manual cleanup. Multiple `--load-extension` directives retain Chromium's last-directive-wins behavior; earlier inactive lists are not re-enabled.

Flags are parsed with GLib through the already-shipped system Python/PyGObject packages, matching Chromium's launcher rather than interpreting each line as one argument. The merger preserves unrelated argument text and comments, quotes the updated extension argument, and validates the resulting argv. It never sources or evaluates flags. Malformed syntax fails without rewriting the flags file.

Manually loaded standalone copies may need removal in the browser's extension manager. Do not run the standalone uninstaller after takeover: it can remove the now-bundled `com.omarchy.theme` registration. The bundled installer does not rewrite browser Preferences or Secure Preferences.

## CSS API

Every valid flat key in the current `colors.toml` is exposed as `--omarchy-<key>`, with underscores changed to hyphens. A key such as `bright_green` becomes `--omarchy-bright-green`. Values update in place when the palette changes, and removed keys are cleared.

```css
.card {
  background: var(--omarchy-background, #101913);
  color: var(--omarchy-foreground, #a1af9c);
  border: 1px solid var(--omarchy-accent, #4a9a68);
}

html[data-omarchy-mode="light"] .card {
  box-shadow: 0 1px 4px #0002;
}
```

Always use fallback values for browsers without the extension. `<html>` also receives `data-omarchy-theme` and `data-omarchy-mode`. The extension does not set `color-scheme`, so unrelated form controls and scrollbars are not changed automatically.

## JavaScript API

Check for `window.omarchy` before calling it. The first palette arrives asynchronously; reads may initially be empty, and `onChange` fires when that first palette arrives.

| Member | Result |
| --- | --- |
| `theme` | Current theme name, or `null` before it arrives |
| `mode` | Current mode, usually `dark` or `light`, or `null` |
| `colors()` | Snapshot of all exposed colors |
| `color(name)` | One value, accepting underscores or hyphens, or `null` |
| `onChange(handler)` | Calls the handler with a frozen color snapshot; returns an unsubscribe function |
| `canSetTheme()` | Promise of `{ allowed, origin }`, or an error result if the worker is unavailable |
| `setTheme(name)` | Promise of `{ ok, name, error }` for an installed theme |
| `installTheme(spec)` | Promise of `{ ok, name, error }` for a new validated theme |

```js
const api = window.omarchy;
if (api) {
  console.log(api.theme, api.color('accent'));
  const stop = api.onChange((colors) => {
    console.log('Updated palette:', colors);
  });
  // Call stop() when the view is removed.
}
```

`omarchythemechange` is also dispatched on `document`, without event detail. Read the current values from the API or CSS. DOM values and events are visible to page scripts and are not an authentication mechanism.

## Theme Writes

By default, only the top-level `https://omarchy.org` origin may set or install themes. Localhost, local files, other websites, subdomains, and embedded frames cannot write. An allowed page can request changes without a separate confirmation prompt; this includes any compromised or third-party script executing in that origin.

Run examples with `await` in a browser console or JavaScript module on an allowed page:

```js
const api = window.omarchy;
if (api && (await api.canSetTheme()).allowed) {
  const result = await api.setTheme('Tokyo Night');
  if (!result.ok) console.error(result.error);
}
```

`setTheme` selects an installed theme through Omarchy's normal theme command. Names are normalized for matching. `{ ok: true }` acknowledges the request, not completed desktop application; palette pushes provide the subsequent update.

### Install a Theme

Palette-only installs remain valid. Images, mode, and icon selection are optional. The URLs below are placeholders for assets on the allowed image service:

```js
const images = 'https://wallpapers.hel1.your-objectstorage.com/my-theme';
const result = await window.omarchy.installTheme({
  name: 'My Web Theme',
  mode: 'dark',
  colors: {
    background: '#101913',
    foreground: '#a1af9c',
    accent: '#4a9a68',
  },
  iconsTheme: 'Yaru-blue',
  backgroundUrls: [`${images}/first.webp`, `${images}/second.jpg`],
  previewUrl: `${images}/preview.png`,
  previewUnlockUrl: `${images}/preview-unlock.png`,
  unlockUrl: `${images}/unlock.png`,
});
if (!result.ok) console.error(result.error);
```

| Input | Generated source content |
| --- | --- |
| `name` | Normalized directory name under `~/.config/omarchy/themes/` |
| `colors` | `colors.toml`; `background`, `foreground`, and `accent` are required |
| `mode` | Optional `dark` or `light` line in `colors.toml`; not a color key |
| `iconsTheme` | Optional `icons.theme`, naming an installed system icon theme |
| `backgroundUrls` | Up to eight ordered JPEG, PNG, or WebP files in `backgrounds/` |
| `backgroundUrl` | Legacy single-image form; cannot be combined with `backgroundUrls` |
| `previewUrl` | Optional PNG-only `preview.png` |
| `previewUnlockUrl` | PNG-only `preview-unlock.png`, paired with `unlockUrl` |
| `unlockUrl` | PNG-only `unlock.png`, paired with `previewUnlockUrl` |

New source directories contain only those files and `backgrounds/`. Background filenames use `001-<slug>.<ext>`, `002-<slug>.<ext>`, and so on. Including the slug avoids matching another theme's previous background basename during first application. There is no raw TOML, file map, arbitrary path, archive, Lua, shell script, or template input. Existing user themes, built-in names, and symlinks are never overwritten.

`iconsTheme` is a bounded ASCII identifier whose directory and `index.theme` must resolve inside `/usr/share/icons`; it does not download icon packs. The unlock pair cannot use the reserved name `default`. Installing unlock assets does not request root access or apply boot/login settings; Omarchy's separate unlock selection remains a user action. The source-file allowlist does not restrict the application configs Omarchy generates later from trusted templates.

## Permissions and Limits

- Reads expose the palette and theme name on every page where the content scripts run, including subframes. Custom colors can help fingerprint users; there is no per-site read opt-in.
- The manifest requests `nativeMessaging`, local `storage`, and an exact HTTPS wallpaper host permission. It does not add a generic network proxy or a root service.
- Every asset URL must use `https://wallpapers.hel1.your-objectstorage.com` on the default port, without URL credentials. The worker rejects all redirects, validates the full list before fetching, and omits request credentials.
- Downloads run sequentially with one 30-second deadline and an 8 MiB combined image-byte budget. A failed batch is never posted as a partial theme.
- Installation allows at most eight backgrounds, three fixed PNG assets, 128 colors, 32-character color keys, and 64-character input names. Colors must be exact six-digit hex values.
- Native messages have a 12 MiB request cap and a 1 MiB response cap. Palette source files over 64 KiB produce an empty palette instead of unbounded data.
- A shared per-user installation lock enforces a persisted two-second admission interval and a quota of 64 browser-created themes / 256 MiB apparent size. The separate apply interval remains two seconds per native connection.
- New quota membership lives outside source themes in `~/.local/state/omarchy/browser-theme-host/themes/<slug>`. Legacy `.omarchy-browser-theme` markers still count once. Valid stale records do not consume quota, while abandoned staging directories do.
- Membership is recorded before same-filesystem, no-clobber publication. Known failures remove only new unused reservations; potentially published themes retain accounting. Staging may temporarily use another 8 MiB plus palette/directory overhead.
- The native installation response deadline is 60 seconds, versus 15 seconds for `setTheme`. A caller timeout does not release installation admission until native work replies or disconnects.

Image checks validate signatures and header bounds, not full image decoding. Local filesystem access, installed icon themes, Omarchy commands, templates, and hooks remain trusted. Adding write origins or image hosts changes the trust boundary and should be reviewed explicitly.

## Validation

Run the focused integration and runtime tests:

```bash
bash test/shell.d/chromium-theme-sync-install-test.sh
bash test/shell.d/chromium-theme-sync-runtime-test.sh
```

The runtime fixtures exercise the actual page/content bridge, worker logic, and native framing/staging with temporary HOME/XDG paths and stubbed desktop commands. Fetches and native ports are mocked in the worker tests. Integration tests cover fresh setup, migration, flag preservation, same-ID takeover, symlinked configs, and retryable failures.

Before merge, exercise fresh installation and upgrade in a disposable Omarchy VM, restart Chromium, confirm palette changes reach a real page, and verify a permitted multi-asset install. The unit/shell tests do not replace those live browser and package-upgrade checks. Do not run acceptance tests against the active development desktop.
