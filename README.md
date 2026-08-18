<p align="center">
  <a href="https://github.com/Denszh/dsh-desktop">
    <img src="resources/app-icon.png" width="96" alt="dsh-desktop" />
  </a>
</p>

<h1 align="center">dsh-desktop</h1>

<p align="center">
  在桌面上运行 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 的桌面壳 ——<br />
  无需预装 Node.js，一键安装，双击即用。
</p>

<p align="center">
  <a href="https://github.com/Denszh/dsh-desktop/releases">
    <img src="https://img.shields.io/github/v/release/Denszh/dsh-desktop?style=flat-square&amp;label=release&amp;color=4D6BFE" alt="Release" />
  </a>
  <img src="https://img.shields.io/github/license/Denszh/dsh-desktop?style=flat-square&amp;label=license&amp;color=4D6BFE" alt="MIT License" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-black?style=flat-square" alt="macOS | Windows" />
</p>

<p align="center">
  <samp><strong>简体中文</strong> · <a href="./README.en.md">English</a></samp>
</p>

## 功能

- ⚡️ **零配置启动**：首次启动自动下载 Node 运行时与 Harness 核心，之后全部本地运行，无需预装任何环境
- 🔄 **运行时分发**：安装包不携带 dsh 依赖树；首次运行从 GitHub Releases 下载 `dsh-runtime-<platform>-<arch>.zip`，后续复用本地缓存
- 🪶 **Node 运行时兜底**：优先使用系统 Node 22+；若系统没有合适版本，自动下载独立 Node 运行时到本地
- 🔒 **本地优先**：dsh 服务运行在 `127.0.0.1`，会话与设置保存在本机
- 📌 **托盘驻留**：关闭窗口不退出，dsh 后台继续运行；托盘菜单可打开窗口、重启服务、退出
- 🛡️ **进程守护**：安全回收 dsh 子进程（含强杀后残留的孤儿进程）
- 🔄 **自动更新**：通过 electron-updater 检查 GitHub Releases，新版本自动下载，重启时完成升级

## 快速开始

从 [Releases](https://github.com/Denszh/dsh-desktop/releases) 下载对应平台的安装包，安装后启动即可。

首次运行会下载 Node 运行时与 Harness 核心（约几百 MB），随后直接进入 `http://127.0.0.1:<port>` 的 Harness 界面。之后一切本地运行，无需网络。

**要求**：macOS 10.15+ / Windows 10+（64 位）· 首次启动需联网

## 工作原理

```text
┌──────────────────────────────────────────────┐
│ Electron 壳 (BrowserWindow)                  │
│   loadURL(dsh web) → 显示 Harness 界面        │
│   托盘菜单 / 自动更新 / 进程守护               │
└──────────────────────┬───────────────────────┘
                       │ spawn (node → dsh)
┌──────────────────────┴───────────────────────┐
│ Electron 主进程                              │
│   ensureDshRuntime   下载/解压 dsh 运行时      │
│   ensureNodeRuntime  按需下载 Node 22         │
│   DshProcess         端口发现 + 生命周期       │
│   updater            自动更新检查              │
└──────┬───────────────────────────┬───────────┘
       │                           │
  userData/dsh-runtime/       userData/node-runtime/
  (预打包 dsh 依赖)           (Node v22 运行时)
       └─────────────┬─────────────┘
                     ▼
   node dsh/lib/bin.js --profile web --port 0
                     │
                     ▼
        http://127.0.0.1:<port>/  ← dsh web UI
```

预打包的 Harness 运行时发布在 [dsh-desktop Releases](https://github.com/Denszh/dsh-desktop/releases) 的 runtime release 中，按平台/架构区分（`dsh-runtime-<platform>-<arch>.zip`）。

## 开发

### 环境

```bash
pnpm install      # 安装依赖
pnpm start        # 启动（开发模式）
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm start` | 开发模式启动（使用项目内 dsh） |
| `pnpm dist:mac` | 打包 macOS（dmg/zip） |
| `pnpm build:dsh-runtime` | 构建 dsh 运行时压缩包 |
| `pnpm release <ver> <notes>` | 一键发布（签名 + 公证 + GitHub Release） |

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `DSH_SOURCE` | 空 | 设为 `repo` 时使用本地源码模式（开发调试） |
| `DSH_REPO` | `~/personal/deepseek-harness` | 本地源码模式下的 dsh 仓库路径 |
| `DSH_PROFILE` | `web` | dsh profile 名 |
| `DSH_NODE` | 空 | 指定 Node.js 绝对路径（优先于自动探测） |
| `DSH_RUNTIME_VERSION` | `0.1.0-rc.6` | 运行时下载的 dsh 版本 |
| `DSH_DISABLE_SYSTEM_NODE` | 空 | 设为 `1` 时强制跳过系统 Node，用独立运行时 |

### 目录结构

```
src/main/index.js    Electron 主进程：运行时下载/启动 dsh、端口发现、托盘、生命周期
src/main/updater.js  App 自动更新（electron-updater 封装）
src/preload/          contextBridge 安全桥
src/renderer/         加载中/错误页（实际 UI 由 dsh web 提供）
scripts/build-dsh-runtime.sh  构建运行时压缩包
scripts/release.sh            一键发布脚本
.github/workflows/release.yml GitHub Actions 发布流水线
```

## 技术要点

- **运行时分发**：安装包不包含 dsh 依赖树；首次运行下载 `dsh-runtime-<platform>-<arch>.zip` 到 userData/dsh-runtime
- **Node 运行时兜底**：优先使用系统 Node 22+；若没有，自动下载 `node-v22.23.1-<platform>-<arch>` 到 userData/node-runtime
- **进程组管理**：dsh 以独立进程组运行，停止时整棵进程树（node → dsh）一并回收
- **退出路径**：托盘"退出"/Cmd+Q 时先回收 dsh 子进程再退出；强杀 Electron 时通过 state 文件记录进程组 PID，下次启动自动清理孤儿进程
- **自更新机制**：打包版启动 30 秒后及此后每 6 小时自动检查更新
- **CI 缓存**：GitHub Actions 缓存 dsh-runtime 构建结果（`~/.npm` + `.dsh-runtime-cache`），大幅缩短 Windows 构建时间

## 已知限制

- macOS 自动更新需要 Developer ID 签名；未签名版本不会自动更新，需手动下载新版
- macOS Electron 主进程吞掉 SIGTERM/SIGINT，孤儿进程依赖下次启动清理
- 首次运行需联网下载运行时（Node + dsh，约几百 MB）

## 更新日志

所有版本的变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## License

[MIT](LICENSE)
