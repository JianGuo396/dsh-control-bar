#!/usr/bin/env bash
# 仓库要满 24 小时才能过 awesome-dsh-plugin 的 CI（2026-10-26 02:46 UTC 建仓 → 之后任何时间都行）。
# 这个脚本做剩下的事：把 PR 开到上游 main。分支和文件已经在 fork 上了。
#
#   bash submission/open-pr.sh
set -euo pipefail
export PATH="$HOME/.dsh/tools:$PATH"

UPSTREAM="awesome-dsh-plugin/awesome-dsh-plugin"
FORK_OWNER="JianGuo396"
BRANCH="add-control-bar"

echo "== 仓库年龄"
CREATED=$(gh api "repos/${FORK_OWNER}/dsh-control-bar" --jq .created_at)
echo "  建仓时间：$CREATED"
echo "== 开 PR"
gh pr create \
  --repo "$UPSTREAM" \
  --base main \
  --head "${FORK_OWNER}:${BRANCH}" \
  --title "Add dsh-control-bar: 操控状态栏 + DeepSeek 峰谷守门" \
  --body "$(cat <<'BODY'
## 新增条目

`data/plugins/JianGuo396__dsh-control-bar.yml` —— 一个插件，一个文件。

**它做什么**：模型直接操控这台电脑（点鼠标、敲键盘、跑改状态的命令）时，屏幕顶部常驻一条置顶进度条，
显示「正在操控」+ 当前步骤 + 真实百分比；同时在右侧标出此刻是 DeepSeek 峰时还是谷时，
并让大额 token 的操作只在峰时请求用户确认，谷时直接执行。

**实现要点**（对照条目里的描述，逐条可核）
- `lib/overlay/main.cjs`：独立 Electron 进程（`screen-saver` 级别、鼠标穿透、`showInactive`、无键盘焦点）。
- `lib/phase.cjs`：峰谷算法，峰时 = 北京时间 09:00–12:00、14:00–18:00（周一至周五，排除内置的 2026 法定节假日），谷时单价为峰时一半。
- `lib/index.js`：注册两个工具 `control_bar`（start/update/finish/hide）与 `peak_valley`，并注入一节系统提示写清守门规则。
- `package.json` 声明 `dsh.bundle.patch`（无 `dsh.client`：状态栏是 OS 窗口，页面里不画东西）。
- `test/`：峰谷 15 例断言 + 插件契约 26 项，`node test/phase.selftest.cjs`、`node test/plugin.selftest.mjs` 本地全过。
BODY
)" \
  --label "" 2>/dev/null || gh pr create \
  --repo "$UPSTREAM" \
  --base main \
  --head "${FORK_OWNER}:${BRANCH}" \
  --title "Add dsh-control-bar: 操控状态栏 + DeepSeek 峰谷守门" \
  --body "新增条目 data/plugins/JianGuo396__dsh-control-bar.yml。详见 https://github.com/JianGuo396/dsh-control-bar"

echo "== 看 CI"
gh pr list --repo "$UPSTREAM" --head "${FORK_OWNER}:${BRANCH}" --json number,title,url --jq '.[]'
