# Agent Note: 每 PR 预览部署上 Cloudflare Pages

Status: implemented
Archived: 2026-09-04

[English](2026-08-20-preview-cloudflare-pages-deploy.md) | 中文

## 问题

浏览器 worker 预览的存在意义是观察某个 pull request 的前端与 host 代码运行态，因此需要一个外人无法访问的、按 pull request 隔离的静态托管。GitHub Pages 的私有发布只在 GitHub Enterprise Cloud 上可用，而本组织尚未定夺；且一个仓库一个 Pages 站点无法隔离多个 pull request。首次部署运行还暴露了一个打包缺陷：干净 checkout 上 `pnpm install` 永远不会创建 `dsh-pack-vfs-image` 的 bin 链接，`build:preview` 在任何「install 不是在 build 之后跑的」工作树上都以 `command not found` 失败。

## 决定

**部署。**pull request 的每次推送把 `apps/web/dist` 发布到 Cloudflare Pages 项目 `dsh-build-preview` 的分支别名 `pr-<number>` 下，置于 Cloudflare Access 之后（`.github/workflows/build-preview-cloudflare.yml`）。上传只携带构建产物——平台永远拿不到仓库源码，sourcemap 因内嵌完整源码在上传前删除。`preview.html` 顶替 `index.html` 成为部署根：served 页面没有 host 注入 `window.__DSH_BOOT__` 就无法启动，所以根必须是能启动的那张页。同一 pull request 内最新构建胜出；不同 pull request 各占各的别名 URL，互不争抢。运行只有在 service token 请求证明受保护 URL 真的送达打包镜像后才算通过：HTTP 200（Access 放行了该 token；302 意味着 Access 策略缺 Service Auth 规则）、无 `content-encoding`（平台不得对已压缩的 body 声明传输压缩，否则 worker 的 `DecompressionStream` 会对着解开的裸 tar 充气）、gzip 魔数 `1f 8b`。带标记守卫的评论对每个 pull request 只报一次稳定别名 URL。

**bin 链接。**pnpm 只在链接目标于 install 时已存在的情况下创建 workspace bin 链接。`bin` 指向构建产物（`lib/bin.js`）因此在干净 checkout 上永远得不到链接——事后构建不会补建链接。packer 在包根提交 `bin.js` 作为稳定链接目标；它转发到 `lib/bin.js`，构建产物缺失时点名 `pnpm run build` 并以 1 退出。与 `dsh-subprocess-local` 提交 spawn-helper 入口是同一模式。

## 曾考虑的替代方案

**GitHub Pages 私有发布。**Enterprise Cloud 独占，且 `deploy-pages` 整站替换，多个 pull request 会互相覆盖；按分支子目录要走遗留的分支部署通道并吃其构建频率限制。

**用 Actions artifact 当预览。**下载权限与仓库 read 权限逐字对齐、零成本，但 artifact 是 zip 下载不是可浏览的站点。留作 Cloudflare 面失效时的兜底。

**用「build 之后再 install 一次」的文档说明代替提交链接目标。**让每个干净 checkout 都以一种错误信息解释不了的、依赖顺序的方式坏掉；CI 每次运行恰恰就是这样的 checkout。

## 后果

pull request 的预览位于 `https://pr-<number>.dsh-build-preview.pages.dev`，访问要求 Cloudflare Access 登录；自动化用 service token 通行。部署平台不持有源码与 sourcemap，这也意味着在 sourcemap 处理被专门设计之前，预览无法把 bundle 映射回源码。镜像的字节通路——压缩存储、无传输再编码送达——在每次部署时被断言，平台行为变化会让运行失败而不是让 worker 启动失败。packer bin 在任何干净 checkout 上一次完整构建后即可用，constraints 表把 `bin.js` 钉进发布文件清单。
