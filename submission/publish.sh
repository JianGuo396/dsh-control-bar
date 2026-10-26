#!/usr/bin/env bash
# 一键发布：npm + GitHub 推送。PR 那步需要网页操作，脚本最后把条目打出来。
#
#   bash submission/publish.sh              # 正常发布
#   DRY=1 bash submission/publish.sh        # 只检查，不发不推
#
# 前置（只能用你自己的账号，我这边没有凭据）：
#   1) npm login          —— 否则 npm publish 报 ENEEDAUTH
#   2) 在 GitHub 建好仓库 JianGuo396/dsh-control-bar（空仓库、不要勾 README）
#      首次 git push 会弹 Git Credential Manager 让你登录一次，之后就不用再登
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="JianGuo396/dsh-control-bar"
DRY="${DRY:-0}"

echo "== 0/4 包检查"
node -e "const p=require('./package.json');console.log('name:',p.name,'version:',p.version,'files:',p.files.length,'repository:',p.repository.url)"
node --check lib/index.js
node test/phase.selftest.cjs | tail -1
node test/plugin.selftest.mjs | tail -1

echo "== 1/4 npm 登录状态"
if ! npm whoami >/dev/null 2>&1; then
  echo "  没登录。先在终端跑：npm login" >&2
  exit 1
fi
npm whoami

if [ "$DRY" = "1" ]; then
  echo "DRY=1，到此为止。"
  exit 0
fi

echo "== 2/4 发布到 npm"
npm publish --access public

echo "== 3/4 推送 GitHub"
git remote add origin "https://github.com/${REPO}.git" 2>/dev/null \
  || git remote set-url origin "https://github.com/${REPO}.git"
git branch -M main
git push -u origin main

echo "== 4/4 提 PR（网页操作）"
echo "  1. fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"
echo "  2. 在你的 fork 里新建文件 data/plugins/JianGuo396__dsh-control-bar.yml"
echo "     内容就是下面这份（注意 YAML 里含「: 」的字符串已经加引号）："
echo "----------------------------------------------------------------"
cat submission/data-plugins.yml
echo "----------------------------------------------------------------"
echo "  3. 对着上游 main 开 PR。CI 会查：条目 ≤3、仓库有 dsh.bundle、仓库满 1 天、awesome-lint。"
echo "  4. 记得给 ${REPO} 加 dsh-plugin topic，否则 CI 会提示。"
