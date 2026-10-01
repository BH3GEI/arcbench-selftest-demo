#!/usr/bin/env bash
# 把当前目录（含 Dockerfile、frontend/、backend/ 等）打成符合自测网站要求的 zip。
# 用法：在你的项目根目录（和 Dockerfile 同级）运行：
#   bash pack.sh [输出文件名，默认 submission.zip]
set -euo pipefail

OUT="${1:-submission.zip}"

if [ ! -f "Dockerfile" ]; then
  echo "错误：当前目录没有 Dockerfile。zip 的根目录必须直接包含 Dockerfile。" >&2
  exit 1
fi

rm -f "$OUT"

zip -r -X "$OUT" . \
  -x '.git/*' \
  -x '*/.git/*' \
  -x '*/node_modules/*' \
  -x 'node_modules/*' \
  -x '*.zip' \
  -x '.DS_Store' \
  -x '*/.DS_Store' \
  -x '.env' \
  -x '.env.*' \
  -x '*/.env' \
  -x '*/.env.*' \
  >/dev/null

SIZE_BYTES=$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT" 2>/dev/null)
SIZE_MB=$((SIZE_BYTES / 1024 / 1024))

echo "已生成 $OUT（约 ${SIZE_MB}MB）"
if [ "$SIZE_MB" -gt 50 ]; then
  echo "警告：超过 50MB 上限，上传会被拒绝。检查是否打包了 node_modules、.git 或其他大文件。" >&2
fi

if unzip -l "$OUT" | grep -qE '^\s*[0-9]+\s+.*\s\.\./'; then
  echo "警告：zip 里似乎有跳出目录的路径（../），上传会被拒绝。" >&2
fi

echo "确认 zip 根目录下有 Dockerfile："
unzip -l "$OUT" | grep -E '^\s*[0-9]+.*\sDockerfile$' || echo "警告：没有在根目录找到 Dockerfile。" >&2
