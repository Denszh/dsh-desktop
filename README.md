# dsh-desktop

DeepSeek Harness 桌面壳 —— 用 Electron 包装 dsh web，提供托盘管理、进程守护和自动更新。

## 功能

- **一键启动**：主进程 spawn `pnpm dsh --profile web --port 0`，OS 自动分配端口，自动打开窗口
- **托盘驻留**：关窗口不退出，dsh 后台继续跑；托盘菜单可打开/重启/退出
- **端口自动发现**：解析 dsh stdout 的 `dsh web: http://127.0.0.1:<port>` 行
- **孤儿清理**：Electron 被强杀（崩溃/SIGKILL）后，下次启动自动回收残留的 dsh 进程
- **正式图标**：用 dsh 官方 favicon（鲸鱼 logo）生成 Dock app 图标 + 托盘 Template 图标

## 自动更新三套机制

### ① fork 同步（远程分发）
每 60s `git fetch origin`（`origin` = 你的 fork `Denszh/deepseek-harness`），检测到 fork 有新提交 → `git pull --ff-only` → 自动重启 dsh。
**场景**：你本地改 dsh 源码/插件 → push 到 fork → dsh-desktop 最多 1 分钟后自动拉到并重启，新插件立即生效。

### ③ 本地监听（开发即时反馈）
`fs.watch` 监听 DSH_REPO 的 `packages/`、`examples/`、`hello-plugin/` 等目录，源码变化（2s 防抖）→ 自动重启 dsh。
**场景**：本地开发插件时，保存即生效，无需手动重启。

### ② app 自更新（electron-updater）
打包版本通过 electron-updater 检查 GitHub Releases（`Denszh/dsh-desktop`）。需用 `electron-builder --publish always` 发布带 `latest-mac.yml` 的 Release 后才生效。

**git remote 约定**（`~/personal/deepseek-harness`）：
- `origin` = 你的 fork `Denszh/deepseek-harness`（同步来源）
- `upstream` = 官方 `deepseek-ai/deepseek-harness`

## 使用

```bash
pnpm install      # 安装 electron + electron-builder
pnpm start        # 启动（开发模式）
pnpm dist:mac     # 打包 macOS dmg/zip
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `DSH_REPO` | `~/personal/deepseek-harness` | dsh 源码仓库路径 |
| `DSH_PROFILE` | `web` | dsh profile 名 |

## 架构

```
src/main/index.js    Electron 主进程：spawn dsh、端口发现、托盘、进程生命周期
src/preload/          contextBridge 安全桥
src/renderer/         加载中/错误页（实际 UI 由 dsh web 提供）
scripts/gen-icons.js  从 dsh favicon.svg 生成 app/tray/icns 图标
test-dsh-process.js   独立测试：验证 spawn/kill/孤儿清理（无 GUI）
```

## 关键设计

- **进程组管理**：dsh 用 `detached:true` 建独立进程组，`stop()` 用 `process.kill(-pid)` 杀整棵进程树（pnpm → node → dsh）
- **退出路径**：
  - 托盘"退出"/Cmd+Q → `will-quit` 回收 dsh 后 `app.exit`
  - 强杀 Electron（macOS 吞 SIGTERM）→ state 文件记录 groupPid，下次启动自动清理
- **state 文件**：`~/Library/Application Support/dsh-desktop/dsh-state.json`
- **图标**：`resources/` 下 app-icon.png（深蓝圆角 + 白色 logo）、tray-icon.png（白色透明）、icon.icns；打包后经 `extraResources` 分发，运行时用 `process.resourcesPath` 优先定位

## 打包决策

**开发模式 `pnpm start` 即可**；打包成 `.app` 用于启动台安装（已发布到 GitHub，支持自动更新检查）。

| 维度 | 说明 |
|------|------|
| 壳仍依赖源码 | 运行时靠 `DSH_REPO` 指向的 dsh 源码（tsx 运行） |
| fork 同步解决分发 | dsh 源码更新走 ①（fork git pull），dsh-desktop 壳不变即可应用新插件 |
| app 自更新可选 | ② electron-updater 需 GitHub Release 才生效，属于增量增强 |

## 已知限制

- macOS Electron 主进程吞掉 SIGTERM/SIGINT，JS handler 不触发（Electron 平台行为），孤儿清理依赖下次启动
- 依赖 `DSH_REPO` 指向的源码已 `pnpm install` 且构建过
- `sharp` 仅用于一次性生成图标（`scripts/gen-icons.js`），非运行时依赖
- fork 同步（①）只在工作区干净时 `--ff-only` 生效；本地有未提交改动会 pull 失败（托盘菜单显示错误，改完即可）
