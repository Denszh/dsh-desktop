# dsh-desktop

DeepSeek Harness 桌面壳 —— 用 Electron 包装 dsh web，提供托盘管理和 App 自动更新。

## 功能

- **一键启动**：主进程自动启动 dsh web 服务（`--port 0` 由系统分配端口），就绪后自动打开应用窗口
- **首次运行下载 dsh + Node**：首次启动会从 GitHub Releases 下载预打包的 dsh 运行时；若系统没有 Node 22+，还会自动下载独立 Node 运行时，后续都复用本地缓存
- **托盘驻留**：关闭窗口不退出应用，dsh 服务在后台继续运行；托盘菜单可打开窗口、重启服务、退出
- **端口自动发现**：解析 dsh 启动输出中的服务地址，托盘菜单实时显示当前端口
- **进程守护**：安全回收 dsh 子进程（含强杀 Electron 后残留的孤儿进程）
- **App 自动更新**：通过 electron-updater 检查 GitHub Releases，新版本发布后自动下载，重启时完成升级；托盘菜单可手动"检查 App 更新"
- **正式图标**：采用 dsh 官方鲸鱼 logo 生成的应用图标与托盘图标

## 快速开始

```bash
pnpm install   # 安装依赖
pnpm start     # 启动（开发模式）
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `DSH_SOURCE` | 空 | 设为 `repo` 时，使用本地源码模式（开发调试） |
| `DSH_REPO` | `~/personal/deepseek-harness` | 本地源码模式下的 dsh 仓库路径 |
| `DSH_PROFILE` | `web` | dsh profile 名 |
| `DSH_NODE` | 空 | 指定 Node.js 绝对路径（优先于自动探测） |
| `DSH_RUNTIME_VERSION` | `0.1.0-rc.6` | 运行时下载的 dsh 版本 |

## 架构

```
src/main/index.js    Electron 主进程：下载/启动 dsh、端口发现、托盘、进程生命周期
src/main/updater.js  App 自动更新（electron-updater 封装）
src/preload/          contextBridge 安全桥
src/renderer/         加载中/错误页（实际 UI 由 dsh web 提供）
```

## 技术要点

- **运行时分发**：安装包不包含 dsh 依赖树；首次运行下载 `dsh-runtime-<platform>-<arch>.zip` 到 userData/dsh-runtime
- **Node 运行时兜底**：优先使用系统 Node 22+；若没有，则自动下载 `node-v22.23.1-<platform>-<arch>` 到 userData/node-runtime
- **进程组管理**：dsh 以独立进程组运行，停止时整棵进程树（node → dsh）一并回收
- **退出路径**：托盘"退出"/Cmd+Q 时先回收 dsh 子进程再退出；强杀 Electron 时通过 state 文件记录进程组 PID，下次启动自动清理孤儿进程
- **自更新机制**：打包版启动 30 秒后及此后每 6 小时自动检查更新，无需任何手动操作

## 已知限制

- 默认运行模式优先使用系统 **Node.js >= 22**；若没有，会自动下载独立 Node 22 运行时
- macOS 自动更新需要 Developer ID 签名；未签名版本不会自动更新，需手动下载新版
- macOS Electron 主进程吞掉 SIGTERM/SIGINT，孤儿进程依赖下次启动清理
