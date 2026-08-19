#!/usr/bin/env bash
# dsh-desktop 一键发布脚本
#
# 用法：
#   ./scripts/release.sh 0.2.0 "发布说明"
#
# 功能：
#   1. 校验版本号 + 更新 package.json 版本
#   2. 检查签名/公证凭据
#   3. 构建 dsh 运行时压缩包并发布 runtime release
#   4. 打包（签名 + 公证）
#   5. 发布 GitHub Release（dmg + zip + latest-mac.yml）
#
# 前置条件：
#   - Apple Developer ID 证书已安装钥匙串（Developer ID Application）
#   - 环境变量（可写 .env 或 export）：
#       APPLE_ID               Apple 开发者账号邮箱
#       APPLE_APP_SPECIFIC_PASSWORD  App 专用密码
#       APPLE_TEAM_ID          团队 ID
#   - gh CLI 已登录
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 加载 .env（如存在），凭据不入库
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

VERSION="${1:-}"
NOTES="${2:-}"

if [ -z "$VERSION" ]; then
  echo "用法: ./scripts/release.sh <版本号> [发布说明]" >&2
  echo "示例: ./scripts/release.sh 0.2.0 \"新增 XX 功能\"" >&2
  exit 1
fi

# 校验语义化版本
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "错误: 版本号必须是 x.y.z 格式，收到: $VERSION" >&2
  exit 1
fi

# 检查 git 状态干净
if [ -n "$(git status --porcelain)" ]; then
  echo "错误: git 工作区有未提交改动，请先提交或 stash" >&2
  git status --short >&2
  exit 1
fi

echo "==> [1/5] 更新版本号到 $VERSION"
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '$VERSION';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"
# 维护 CHANGELOG：把 [Unreleased] 内容转入新版本 section，并重开 Unreleased
node -e "
const fs = require('fs');
const path = 'CHANGELOG.md';
let c = fs.readFileSync(path, 'utf8');
const v = '$VERSION';
const today = new Date().toISOString().slice(0, 10);
// 提取 Unreleased 内容
const uStart = c.indexOf('## [Unreleased]');
const uEnd = c.indexOf('## [', uStart + '## [Unreleased]'.length);
let unreleased = uStart >= 0 ? c.slice(c.indexOf('\n', uStart) + 1, uEnd < 0 ? c.length : uEnd).trim() : '';
if (!unreleased) {
  console.error('错误: CHANGELOG.md 的 [Unreleased] 为空，请先填写本次变更');
  process.exit(1);
}
const section = '\n## [' + v + '] - ' + today + '\n\n' + unreleased + '\n';
// 插入新版本 section 到第一个已发布版本之前（即 Unreleased 之后）
const insertAt = uEnd < 0 ? c.length : uEnd;
c = c.slice(0, uStart) + '## [Unreleased]\n\n### Added\n\n- （待填写）\n' + section + c.slice(insertAt);
// 更新版本链接：新版本放最前，Unreleased 指向新版本
c = c.replace(/\[Unreleased\]: .*/, '[Unreleased]: https://github.com/Denszh/dsh-desktop/compare/v' + v + '...HEAD\n[' + v + ']: https://github.com/Denszh/dsh-desktop/releases/tag/v' + v);
fs.writeFileSync(path, c);
console.log('CHANGELOG.md 已更新: 添加 v' + v);
"
git add package.json CHANGELOG.md
git commit -m "chore: bump version to $VERSION"
git push origin main

echo "==> [2/5] 检查签名/公证凭据"
: "${APPLE_ID:?需要设置 APPLE_ID 环境变量}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?需要设置 APPLE_APP_SPECIFIC_PASSWORD 环境变量}"
: "${APPLE_TEAM_ID:?需要设置 APPLE_TEAM_ID 环境变量}"
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  echo "错误: 钥匙串中未找到 Developer ID Application 证书" >&2
  exit 1
fi
echo "    签名证书: OK"
echo "    公证凭据: OK"

echo "==> [3/5] 构建 dsh 运行时压缩包"
bash scripts/build-dsh-runtime.sh
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$PLATFORM" in
  mingw*|msys*|cygwin*) PLATFORM="windows" ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH_NAME="x64" ;;
  arm64|aarch64)  ARCH_NAME="arm64" ;;
  *) echo "不支持的架构: $ARCH" >&2; exit 1 ;;
esac
RUNTIME_TAG="dsh-runtime-v${DSH_VERSION:-0.1.0-rc.6}"
RUNTIME_ASSET="release/dsh-runtime-$PLATFORM-$ARCH_NAME.zip"
if [ ! -f "$RUNTIME_ASSET" ]; then
  echo "错误: 缺少运行时压缩包 $RUNTIME_ASSET" >&2
  exit 1
fi
gh release delete "$RUNTIME_TAG" --yes 2>/dev/null || true
gh release create "$RUNTIME_TAG" "$RUNTIME_ASSET" \
  --title "dsh runtime v${DSH_VERSION:-0.1.0-rc.6}" \
  --notes "DeepSeek Harness runtime payload for dsh-desktop"

echo "==> [4/5] 打包（签名 + 公证）"
export CSC_IDENTITY_AUTO_DISCOVERY=true
pnpm dist:mac

echo "==> [5/5] 创建 GitHub Release v$VERSION"
RELEASE_ASSETS=(
  "release/DshDesktop-${VERSION}-arm64.dmg"
  "release/DshDesktop-${VERSION}-arm64.zip"
  "release/latest-mac.yml"
)
for f in "${RELEASE_ASSETS[@]}"; do
  if [ ! -f "$f" ]; then
    echo "错误: 缺少发布产物 $f" >&2
    exit 1
  fi
done

if [ -n "$NOTES" ]; then
  cat scripts/release-notes-template.md > /tmp/release-notes.md
  echo "" >> /tmp/release-notes.md
  echo "$NOTES" >> /tmp/release-notes.md
  gh release create "v$VERSION" "${RELEASE_ASSETS[@]}" \
    --title "DshDesktop v$VERSION" --notes-file /tmp/release-notes.md
else
  gh release create "v$VERSION" "${RELEASE_ASSETS[@]}" \
    --title "DshDesktop v$VERSION" --notes-file scripts/release-notes-template.md
fi

echo "==> 完成"
echo "    发布地址: https://github.com/Denszh/dsh-desktop/releases/tag/v$VERSION"
echo "    用户 app 将自动检测到 v$VERSION 并升级。"
