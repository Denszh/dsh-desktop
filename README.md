# dsh-desktop

DeepSeek Harness 桌面壳 —— 用 Electron 包装 dsh web，提供托盘管理和进程守护。

## 功能

- **一键启动**：主进程 spawn `pnpm dsh --profile web --port 0`，OS 自动分配端口，自动打开窗口
- **托盘驻留**：关窗口不退出，dsh 后台继续跑；托盘菜单可打开/重启/退出
- **端口自动发现**：解析 dsh stdout 的 `dsh web: http://127.0.0.1:<port>` 行
- **孤儿清理**：Electron 被强杀（崩溃/SIGKILL）后，下次启动自动回收残留的 dsh 进程
- **正式图标**：用 dsh 官方 favicon（鲸鱼 logo）生成 Dock app 图标 + 托盘 Template 图标

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

**当前不需要打包**，开发模式 `pnpm start` 即可。原因：

| 维度 | 说明 |
|------|------|
| 壳无独立价值 | 打包产物只是空 Electron 壳，运行时仍依赖 `DSH_REPO` 指向的 dsh 源码（tsx 运行），装上还得配环境变量 |
| dsh 不可分发 | dsh 是源码 + 仓库级 node_modules，`pnpm dsh` 无法随 app 分发 |
| 场景定位 | 解决"看不到实例/端口"的管理痛点，非分发给外部用户 |

**未来需要打包时的前置条件**：
1. 改用官方 npm 包 `@deepseek-ai/dsh`（`npx dsh web`）替代源码 spawn，dsh 才能随安装包独立运行
2. 再启用 electron-builder 4 平台矩阵 + 签名 + 自动更新（参考 mkagent 的 release 流水线）
3. `electron-builder.yml` 已配置好（含正式 icon），届时直接可用

## 已知限制

- macOS Electron 主进程吞掉 SIGTERM/SIGINT，JS handler 不触发（Electron 平台行为），孤儿清理依赖下次启动
- 依赖 `DSH_REPO` 指向的源码已 `pnpm install` 且构建过
- `sharp` 仅用于一次性生成图标（`scripts/gen-icons.js`），非运行时依赖
