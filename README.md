# dsh-desktop

DeepSeek Harness 桌面壳 —— 用 Electron 包装 dsh web，提供托盘管理和 App 自动更新。

## 功能

- **一键启动**：主进程 spawn `pnpm dsh --profile web --port 0`，OS 自动分配端口，自动打开窗口
- **托盘驻留**：关窗口不退出，dsh 后台继续跑；托盘菜单可打开/重启/退出
- **端口自动发现**：解析 dsh stdout 的 `dsh web: http://127.0.0.1:<port>` 行
- **孤儿清理**：Electron 被强杀（崩溃/SIGKILL）后，下次启动自动回收残留的 dsh 进程
- **正式图标**：用 dsh 官方 favicon（鲸鱼 logo）生成 Dock app 图标 + 托盘 Template 图标
- **App 自动更新**：electron-updater 检查 GitHub Releases，发布新版后已安装用户自动升级

## App 自动更新（electron-updater）

**工作流**：
```
用户：从 GitHub Releases 下载 DshDesktop-<ver>.dmg → 安装到 /Applications
作者：打包新版 → 发布到 GitHub Releases（dmg + zip + latest-mac.yml）
用户 app：每 6h 检查 Releases 的 latest-mac.yml → 发现新版 → 下载 zip → 退出时替换 → 重启即新版
```

**macOS 硬性前提：必须 Developer ID 代码签名**。未签名/ad-hoc 签名的 app 无法自动更新（Apple 平台限制）。Windows/Linux 无此限制。

**发布命令**：
```bash
# 需要 Apple Developer ID 证书 + GH_TOKEN 已配置
pnpm dist:mac --publish always
```
或手动：打包后把 `DshDesktop-<ver>.dmg`、`DshDesktop-<ver>.zip`、`latest-mac.yml` 上传到 GitHub Releases 并标记为最新。

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
- **自更新**：`src/main/updater.js` 封装 electron-updater，托盘菜单可手动"检查 App 更新"，启动后 30s + 每 6h 自动检查

## 打包决策

**开发模式 `pnpm start` 即可**；打包成 `.app` 用于启动台安装/分发给用户。app 自动更新依赖 GitHub Releases + Developer ID 签名（macOS）。

## 已知限制

- macOS Electron 主进程吞掉 SIGTERM/SIGINT，JS handler 不触发（Electron 平台行为），孤儿清理依赖下次启动
- **macOS 自动更新必须有 Developer ID 签名**；未签名 app 的 electron-updater 会跳过更新
- 依赖 `DSH_REPO` 指向的源码已 `pnpm install` 且构建过（`~/personal/deepseek-harness`）
- `sharp` 仅用于一次性生成图标（`scripts/gen-icons.js`），非运行时依赖
