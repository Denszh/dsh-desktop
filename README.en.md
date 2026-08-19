<p align="center">
  <a href="https://github.com/Denszh/dsh-desktop">
    <img src="resources/app-icon.png" width="96" alt="dsh-desktop" />
  </a>
</p>

<h1 align="center">dsh-desktop</h1>

<p align="center">
  A desktop shell for running <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> on your desktop —<br />
  no Node.js required, install and go.
</p>

<p align="center">
  <a href="https://github.com/Denszh/dsh-desktop/releases">
    <img src="https://img.shields.io/github/v/release/Denszh/dsh-desktop?style=flat-square&amp;label=release&amp;color=4D6BFE" alt="Release" />
  </a>
  <img src="https://img.shields.io/github/license/Denszh/dsh-desktop?style=flat-square&amp;label=license&amp;color=4D6BFE" alt="MIT License" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-black?style=flat-square" alt="macOS | Windows" />
</p>

<p align="center">
  <samp><a href="./README.md">简体中文</a> · <strong>English</strong></samp>
</p>

## Features

- ⚡️ **Zero setup** — First launch bootstraps the Node runtime and Harness core automatically; everything after that runs locally, no environment setup required.
- 🔄 **Runtime distribution** — The installer carries no dsh dependency tree; the first run downloads `dsh-runtime-<platform>-<arch>.zip` from GitHub Releases, then reuses the local cache.
- 🪶 **Node fallback** — Prefers a system Node 22+; if none is available, it downloads a standalone Node runtime automatically.
- 🔁 **Self-healing core** — Each launch checks GitHub Releases for the latest dsh runtime and upgrades automatically; offline, it keeps the local copy running.
- 🔒 **Local by default** — The dsh service runs on `127.0.0.1`; sessions and settings stay on your machine.
- 📌 **Tray resident** — Closing the window keeps dsh running in the background; the tray menu offers open / restart / quit.
- 🛡️ **Process guard** — Safely reaps dsh child processes, including orphans left by force-killed Electron.
- 🔄 **Auto-update** — electron-updater checks GitHub Releases; new versions download automatically and apply on quit.

## Quick Start

Download the installer for your platform from [Releases](https://github.com/Denszh/dsh-desktop/releases), install, and launch.

The first run downloads the Node runtime and Harness core (~a few hundred MB) and takes you straight into the harness at `http://127.0.0.1:<port>`. Everything after that runs locally — no network required.

**Requirements:** macOS 10.15+ / Windows 10+ (64-bit) · network on first launch

### Which installer should I download?

Not sure which file to pick? Use this simple guide:

| Your computer | Download this file |
|---------------|-------------------|
| **Mac (MacBook / iMac / Mac Studio)** | the one with **`arm64`** in the name (`.dmg`) |
| **Older Intel Mac** | the one with **`x64`** in the name (`.dmg`) |
| **Windows PC** | the one with **`x64`** in the name (`.exe`) |

> 💡 **Tip**: On the [Releases](https://github.com/Denszh/dsh-desktop/releases) page, just look for `arm64` or `x64` in the file name.
> - Newer Mac with Apple silicon → `arm64`
> - Intel Mac or Windows → `x64`
>
> Not sure what chip you have? Open "About This Mac" (Mac) or "System Information" (Windows) and check if it says Apple or Intel.

> 📦 The `.zip` files are for automatic updates — **regular users don't need to download them**.

## How It Works

```text
┌──────────────────────────────────────────────┐
│ Electron shell (BrowserWindow)               │
│   loadURL(dsh web) → renders Harness UI      │
│   tray menu / auto-update / process guard    │
└──────────────────────┬───────────────────────┘
                       │ spawn (node → dsh)
┌──────────────────────┴───────────────────────┐
│ Electron main process                       │
│   ensureDshRuntime   download/extract dsh    │
│   ensureNodeRuntime  download Node 22 on need│
│   DshProcess         port discovery + life   │
│   updater            auto-update checks      │
└──────┬───────────────────────────┬───────────┘
       │                           │
  userData/dsh-runtime/       userData/node-runtime/
  (prebuilt dsh deps)         (Node v22 runtime)
       └─────────────┬─────────────┘
                     ▼
   node dsh/lib/bin.js --profile web --port 0
                     │
                     ▼
        http://127.0.0.1:<port>/  ← dsh web UI
```

The prebuilt Harness runtime is published in the [dsh-desktop Releases](https://github.com/Denszh/dsh-desktop/releases) runtime release, split by platform/arch (`dsh-runtime-<platform>-<arch>.zip`).

## Development

### Setup

```bash
pnpm install      # install dependencies
pnpm start        # launch (dev mode)
```

### Scripts

| Command | Description |
|---------|-------------|
| `pnpm start` | Dev mode (uses the in-project dsh) |
| `pnpm dist:mac` | Package macOS (dmg/zip) |
| `pnpm build:dsh-runtime` | Build the dsh runtime archive |
| `pnpm release <ver> <notes>` | One-shot release (sign + notarize + GitHub Release) |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DSH_SOURCE` | empty | Set to `repo` to use a local source checkout (dev) |
| `DSH_REPO` | `~/personal/deepseek-harness` | dsh repo path in source mode |
| `DSH_PROFILE` | `web` | dsh profile name |
| `DSH_NODE` | empty | Absolute Node.js path (takes priority) |
| `DSH_RUNTIME_VERSION` | `0.1.0-rc.6` | dsh runtime version to download |
| `DSH_DISABLE_SYSTEM_NODE` | empty | Set to `1` to force the standalone runtime |

### Layout

```
src/main/index.js    Electron main: runtime download/start dsh, port discovery, tray, lifecycle
src/main/updater.js  App auto-update (electron-updater wrapper)
src/preload/          contextBridge secure bridge
src/renderer/         loading/error fallback (the real UI is dsh web)
scripts/build-dsh-runtime.sh  build the runtime archive
scripts/release.sh            one-shot release script
.github/workflows/release.yml GitHub Actions release pipeline
```

## Technical Highlights

- **Runtime distribution**: the installer carries no dsh dependency tree; the first run downloads `dsh-runtime-<platform>-<arch>.zip` to userData/dsh-runtime
- **Self-healing core**: each launch compares the GitHub Releases latest dsh runtime version and auto-upgrades; offline / rate-limited, it keeps the local copy running
- **Node fallback**: prefers system Node 22+; otherwise downloads `node-v22.23.1-<platform>-<arch>` to userData/node-runtime
- **Process group management**: dsh runs in its own process group; stopping reaps the whole tree (node → dsh)
- **Exit paths**: tray "quit" / Cmd+Q reaps the dsh child before exiting; force-killed Electron is handled via a state file and cleaned on next launch
- **Auto-update**: packaged builds check for updates 30s after launch and every 6h afterwards
- **CI caching**: GitHub Actions caches dsh-runtime builds (`~/.npm` + `.dsh-runtime-cache`), greatly reducing Windows build time

## License

[MIT](LICENSE)
