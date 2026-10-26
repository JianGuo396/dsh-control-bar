# 上架到插件市场：需要你做的三步

代码、README、图标、截图、条目 yml 都已备好。剩下三步都必须用**你自己的账号**，我这边没有凭据：

```sh
# 0) 本目录已经 git init 并首次提交
git remote add origin https://github.com/JianGuo396/dsh-control-bar.git
git branch -M main && git push -u origin main
```

1. **建 GitHub 仓库**（必须，条目 `url` 指的就是它）
   仓库名 `dsh-control-bar`，推到 `JianGuo396` 名下，然后在仓库 **About → Topics** 加一个 `dsh-plugin`。
   上架要求：仓库里有真实可用代码（✓）、`package.json` 声明了 `dsh.bundle.patch`（✓）、
   仓库创建满 24 小时（所以今天建仓、明天再提 PR）。

2. **发 npm 包**（可选，但强烈建议；不发也能从 GitHub 源码装，只是免不掉构建授权步骤）
   ```sh
   npm login          # 我没有这台机器的 npm 凭据，npm whoami 报 ENEEDAUTH
   cd dsh-control-bar && npm publish --access public
   ```
   `package.json` 里的 `repository` 已指向上面那个仓库，市场会自动把 npm 包和条目关联起来。

3. **提 PR 收录**（一个 PR 只加一个文件，别改 README——那两个文件是脚本生成的）
   把 `submission/data-plugins.yml` 复制成对方仓库的
   `data/plugins/JianGuo396__dsh-control-bar.yml`，然后对
   <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> 开 PR。
   CI 会校验：条目数 ≤3、仓库有 `dsh.bundle`、仓库满 1 天、awesome-lint 与站点构建。

## 可选但推荐

- **市场卡片图标**：条目里 `icon:` 必须是 GitHub 托管的位图（png/jpg/webp，方形约 180px），
  SVG 会被拒。现在包里的 `icon.svg` 只给宿主插件列表用，上架图标要另存一张 PNG 传进仓库。
- **详情页截图**：仓库根已有 `screenshots.json` → `["assets/demo-zh.png"]`，市场会直接读。

## 一个必须重启才会生效的修复

`control_bar` / `peak_valley` 的 `output.render` 之前是缺的（宿主 `defineTool` 里
`const userRender = options.output.render` 直接调用，没有就抛
`output.render failed: userRender is not a function`），已修好并写进 profile 的
`node_modules/dsh-control-bar/lib/index.js`；**宿主进程里是旧模块，重启 DSH 后才会用新代码**。
重启前工具照常写状态、状态栏照常动，只是调用会回报这条错误。
