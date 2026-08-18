# Changelog

所有重要变更都会记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 每版本更新日志维护流程（本文件），发布脚本自动生成

## [0.1.5] - 2026-08-18

### Performance

- GitHub Actions 缓存 dsh-runtime 构建结果（`~/.npm` + `.dsh-runtime-cache`），大幅缩短 Windows 构建时间

### Fixed

- 修复 dsh-runtime 缓存命中时 bash 变量解析问题

## [0.1.4] - 2026-08-18

### Fixed

- 主 GitHub Release 现在包含 macOS 自动更新必需的 zip 资产（`latest-mac.yml` 指向的文件不再 404）

## [0.1.3] - 2026-08-18

### Fixed

- Windows 平台 dsh-runtime zip 平台名归一化（`mingw64_nt-*` → `windows-x64`），Windows 用户可正确下载运行时
- 主 Release 不再混入 dsh-runtime zip（独立发布到 runtime release）

## [0.1.2] - 2026-08-18

### Added

- CI 流水线为各平台构建并发布 dsh-runtime zip（macOS + Windows）

### Fixed

- 清理遗留的 Draft Release

## [0.1.1] - 2026-08-18

### Added

- 方案 1：壳不再打包 dsh 依赖，改为首次运行从 GitHub Releases 下载预打包的 dsh 运行时
- Node 运行时自动下载：系统无 Node 22+ 时自动下载独立 Node 运行时
- 各平台 dsh-runtime 构建发布支持（脚本 + CI）

### Fixed

- Dock 右键退出 / Cmd+Q 现在真正退出并回收 dsh 子进程
- 窗口置前重试（bringToFront），open/Launchpad 启动时窗口自动聚焦
- 单实例锁残留处理，避免打开无反应
- 窗口立即显示（不依赖 ready-to-show），解决二次启动无窗口
- 使用绝对 Node 路径，解决 Dock 启动时找不到 node

[Unreleased]: https://github.com/Denszh/dsh-desktop/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/Denszh/dsh-desktop/releases/tag/v0.1.5
[0.1.4]: https://github.com/Denszh/dsh-desktop/releases/tag/v0.1.4
[0.1.3]: https://github.com/Denszh/dsh-desktop/releases/tag/v0.1.3
[0.1.2]: https://github.com/Denszh/dsh-desktop/releases/tag/v0.1.2
[0.1.1]: https://github.com/Denszh/dsh-desktop/releases/tag/v0.1.1
