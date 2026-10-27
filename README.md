# Another Arc

A personal, performance-first, Arc-style browser for macOS (Apple Silicon), built on Electron.

Spaces with independent tabs, a vertical sidebar, a ⌘T/⌘L command palette, Chrome extension support, and local-only data. The product spec is in [PROJECT.md](PROJECT.md).

## Status

| Phase | State |
|---|---|
| 0 — Technical validation | ✅ Done. See [docs/PHASE0-REPORT.md](docs/PHASE0-REPORT.md) |
| 1 — Browser core (tabs, spaces, sidebar, omnibox, shortcuts, session restore) | ✅ Done |
| 2 — Completeness (downloads, permissions, history, find, zoom, error/crash pages, extensions UI, settings) | ✅ Mostly done. Open items are in [docs/ISSUES.md](docs/ISSUES.md) |
| 3 — Optimization (discarding, perf baseline, packaging) | 🟡 In progress |

## Requirements

- macOS on Apple Silicon
- Node.js 24+, pnpm 9

## Commands

```bash
pnpm install
pnpm dev          # electron-vite dev server with HMR for the shell
pnpm build        # production build into out/
pnpm preview      # run the production build
pnpm typecheck    # tsc (main/preload, renderer, tests)
pnpm test         # unit tests (Vitest)
pnpm test:e2e     # build + integration tests (Playwright driving Electron)
pnpm check        # typecheck + unit tests + build
pnpm dist         # build + package release/Another Arc.app and a .dmg (arm64; signed with your Apple Development / Developer ID certificate if you have one, else ad hoc)
```

Integration tests open real windows but never take focus. Uncaught main-process errors are written to `<userData>/logs/main.log`; no error dialog is shown.

Optional test runs:

- **Real-extension survey.** Point it at a folder of unpacked extensions (one per sub-folder). It writes a report and popup screenshots:
  ```bash
  ARC_REAL_EXT_DIR=/path/to/extensions ARC_REAL_EXT_OUT=/path/to/report \
    ./node_modules/.bin/playwright test tests/e2e/real-extensions.spec.ts
  ```
- **Visual snapshots.** Writes PNGs of key UI states:
  ```bash
  ARC_SHOT_DIR=/path/to/dir ./node_modules/.bin/playwright test tests/e2e/visual.spec.ts
  ```
- **Startup measurement without Playwright.** Writes the startup timeline and memory usage to a file, then quits:
  ```bash
  ARC_USER_DATA=/tmp/arc ARC_PERF_REPORT=/tmp/arc-perf.json ./node_modules/.bin/electron .
  ```

Environment variables: `ARC_USER_DATA` (profile directory), `ARC_OUT_DIR` (alternate build directory, so parallel workers do not clobber `out/`), `ARC_TEST` (set by the test harness), `ARC_TEST_LOCALE` (UI language for integration tests, default `zh-CN`), `ARC_IMPORT_ROOT` (a fake Arc “User Data” folder for **Import from Arc**; under `ARC_TEST` without it, no browser folder is read).

Development builds use a separate profile (`~/Library/Application Support/Another Arc Dev`).

## Keyboard shortcuts

| Keys | Action |
|---|---|
| ⌘T / ⌘L | Command palette: new tab / edit current URL |
| ⌘W, ⌘⇧T | Close tab, reopen closed tab |
| ⌘1–⌘8, ⌘9 | Go to tab N, go to last tab |
| ⌃Tab, ⌃⇧Tab | Next / previous tab |
| ⌘⇧], ⌘⇧[ | Next / previous space |
| ⌘[, ⌘] | Back, forward |
| ⌘R, ⌘⇧R | Reload, hard reload |
| ⌘F, ⌘G, ⌘⇧G | Find in page, next match, previous match |
| ⌘+, ⌘-, ⌘0 | Zoom in, zoom out, reset zoom (remembered per site) |
| ⌘S | Toggle sidebar (hover the left edge to peek) |
| ⌘D, ⌘⇧C | Pin or unpin tab (save it in the sidebar, as in Arc), copy URL |
| ⌘Y, ⌘⇧J, ⌘, | History, downloads, settings |
| ⌘⌥I | Developer tools |

The first group of shortcuts in this table (palette, close/reopen, tab switching, space switching) is reserved: web pages cannot intercept it. All other shortcuts go to the page first.

## Project layout

```
src/
  main/        Electron main process
    app/         bootstrap, protocols, composition root (browser.ts), startup marks, error logging
    tabs/        BrowserModel (pure), TabManager, TabRuntime, discarder, zoom
    windows/     BaseWindow + views controller, shell state sync
    extensions/  manager, installer, compat layer, popup sizing
    history/     SQLite history + FTS5 suggestions, favicon cache
    persistence/ node:sqlite wrapper, migrations, debounced persister
    …            downloads, permissions, profiles, settings, shortcuts, ipc
  preload/     shell bridge (window.arc) and the extension compat shim
  renderer/    React shell: sidebar, palette, find bar, internal pages
  shared/      types, IPC contract, layout math, URL/omnibox logic, patches, i18n
tests/
  unit/        Vitest
  e2e/         Playwright + Electron
  fixtures/    API-probe test extension
docs/          architecture, Phase 0 report, dev log, open issues
```

Architecture and the performance decisions behind it: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Pinned tabs and folders

The sidebar follows Arc: **favorites** (the icon tiles), then each space's **pinned tabs and folders** (the bookmarks), then today's tabs. Pin a tab with ⌘D or drag it up; right-click empty sidebar space → **New Folder**, or right-click a tab → **Add to Folder**; drag folders to reorder or nest them. A pinned tab is a bookmark: closing it (⌘W, ×, middle-click) unloads it and returns it to its saved page, and it stays in the sidebar. Use **Delete from Sidebar** to remove it, or **Update Saved Page** to save the page it is on now.

**Import from Arc** (offered once when a fresh profile starts; also File → Import from Arc…, Settings, or ⌘T): one confirmation brings over the sidebar and the extensions. Arc's spaces, pinned tabs, nested folders and favorites are read from `~/Library/Application Support/Arc/StorableSidebar.json`. They go into the space with the same name (created if missing; Arc's unnamed space maps to your first space). Folders and URLs that are already there are merged, so importing again is safe. Icons come from Arc's own favicon database, then from the network. Arc's folder is only read, never written.

## Space themes

Right-click a space → **Edit Theme…** (or the last swatch in the space editor) to give each space its own look, as in Arc: up to three gradient colors with an angle, how strongly they tint the sidebar, film grain, and a Light / Dark override of the chrome (pages keep following Settings). Changes preview live; Cancel restores the saved look. **Import from Arc** carries Arc's colors, intensity and grain into the spaces it creates, and into spaces whose look was never changed.

## Extensions

Open the Extensions page (app menu → Extensions…, or type “extensions” in the ⌘T palette) and click **Load unpacked extension** to pick a folder containing `manifest.json`. The browser copies it into the profile, so you can later re-import it from the same folder with **Update from source**.

**Import from Arc** (shown when Arc or Chrome is installed; also in the ⌘T palette) copies the extensions turned on in the last-used profile, after a confirmation that lists what is skipped and why. Extension ids stay the same, and **Update from source** picks up the browser’s newer version. Only the files are copied: extension data (wallets, settings, logins) is not, so wallets must be restored again.

Clicking an extension's toolbar button opens its popup or side panel in a small window of its own, titled with the extension's name. Drag it anywhere: it stays above the browser window (not above other apps), remembers where you left it, and stays open when you click elsewhere, so a wallet can sit next to a dApp. Close it with its close button, ⌘W, or another click on the toolbar button. Popups size themselves to their content; side panels open at 380×640 and can be resized.

Most MV3 APIs work, including `declarativeNetRequest`, `offscreen` and `sidePanel` (emulated: the panel opens in the extension's window). Not supported: `webRequest` events, `userScripts`, `identity`, `tabCapture` / `desktopCapture`, and `tabs.captureVisibleTab`. For ad blocking, use **uBlock Origin Lite** rather than uBlock Origin. The per-extension compatibility table is in the Phase 0 report.

## Languages

The UI is in English by default; Settings → Appearance → Language switches to 简体中文 live (sidebar, pages, native menus and dialogs). Strings live in `src/shared/i18n/locales/<locale>/`, one file per module, shared by the main process and the shell. Each non-English file is typed against its English twin, so a missing key fails `pnpm typecheck`; `tests/unit/i18n.test.ts` also checks duplicate keys and `{placeholder}` names. To add a language, add a folder there and an entry in `LOCALES` (`src/shared/i18n/index.ts`).

Integration tests run in Chinese by default (older specs match on Chinese text); `ARC_TEST_LOCALE=en` runs them in English where a spec uses the `t()` helper (e.g. `visual.spec.ts`).

## License note

Chrome extension APIs come from [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell), used under **GPL-3.0**. That is fine for personal use. Distributing this app would require releasing it under GPL-3.0 too, or buying the library's commercial license.
