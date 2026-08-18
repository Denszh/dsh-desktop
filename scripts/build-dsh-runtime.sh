#!/usr/bin/env bash
# 构建 dsh 运行时压缩包（dsh-runtime-<platform>-<arch>.zip）
#
# 方案 1：dsh-desktop 壳不打包 dsh 依赖，改为运行时从 GitHub Releases 下载
# 预打包的 dsh 运行时。本脚本在一个干净目录里安装 @deepseek-ai/dsh（含完整
# node_modules），打成 zip，作为 GitHub Release 的资产上传。
#
# 用法：
#   ./scripts/build-dsh-runtime.sh            # 打当前平台/架构
#   DSH_VERSION=0.1.0-rc.6 ./scripts/build-dsh-runtime.sh   # 指定版本
#
# 产物：release/dsh-runtime-<platform>-<arch>.zip
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DSH_VERSION="${DSH_VERSION:-0.1.0-rc.6}"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"   # darwin / linux
ARCH="$(uname -m)"                                    # arm64 / x86_64
case "$ARCH" in
  x86_64) ARCH_NAME="x64" ;;
  arm64)  ARCH_NAME="arm64" ;;
  *) echo "不支持的架构: $ARCH" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> [1/3] 在干净目录安装 dsh@$DSH_VERSION"
cd "$WORK"
mkdir dsh-runtime
cd dsh-runtime
# 用 hoisted 布局，保证依赖平铺（与 electron-builder 兼容无关，但运行时直接解压即用）
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund "@deepseek-ai/dsh@$DSH_VERSION" >/dev/null 2>&1
npm install --no-audit --no-fund electron-updater >/dev/null 2>&1

echo "==> [2/3] 校验 dsh 入口存在"
if [ ! -f "node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
  echo "错误: dsh bin.js 未找到" >&2
  exit 1
fi

echo "==> [3/3] 打包 dsh-runtime-$PLATFORM-$ARCH_NAME.zip"
mkdir -p "$ROOT/release"
# 精简：去掉不需要的 dev 文件、测试、map
rm -rf node_modules/.cache 2>/dev/null || true
find node_modules -name "*.map" -delete 2>/dev/null || true
find node_modules -type d -name "__tests__" -prune -exec rm -rf {} + 2>/dev/null || true
find node_modules -type d -name "test" -prune -exec rm -rf {} + 2>/dev/null || true
find node_modules -type d -name "tests" -prune -exec rm -rf {} + 2>/dev/null || true

cd "$WORK"
OUT="$ROOT/release/dsh-runtime-$PLATFORM-$ARCH_NAME.zip"
mkdir -p "$ROOT/release"
if command -v zip >/dev/null 2>&1; then
  zip -qr "$OUT" dsh-runtime
else
  # Windows runner 无 zip 命令时的兜底
  powershell.exe -NoProfile -Command "Compress-Archive -Path '$(cygpath -w "$WORK/dsh-runtime/*")' -DestinationPath '$(cygpath -w "$OUT")' -Force" 2>/dev/null \
    || tar -czf "$OUT" dsh-runtime
fi
echo "完成: $OUT"
ls -lh "$OUT" | awk '{print $5, $9}'
