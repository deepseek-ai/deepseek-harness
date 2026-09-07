# Agent Note: README 资产通过专用仓库发布

Status: implemented
Archived: 2026-09-04

[English](2026-08-17-readme-assets-on-cdn.md) | 中文

## 问题

公开中文 README 嵌入了 3 张社区二维码。使用仓库相对路径时，每次替换都依赖源码变更以及独立的公开仓库发布流程，即使图片字节并未改变产品代码或文档文字。

这些图片需要稳定的公开 URL，同时必须明确并可评审地保存源文件字节、发布凭证、缓存行为和更新历史。

## 决策

README 引用 `https://cdn.deepseek.com/harness/readme/` 下的固定 URL。私有仓库 [`deepseek-harness/readme-cdn-assets`](https://github.com/deepseek-harness/readme-cdn-assets) 负责管理 3 张允许发布的 PNG 文件、相应测试和发布代码。向该仓库的 `master` 分支 push 会运行 `publish.yml`，安装固定版本的华为云 OBS SDK、测试 `scripts/upload.mjs` 并发布图片。

上传脚本只接受 3 个 README 图片文件名，验证每个源文件均为 PNG，并以 `Content-Type: image/png` 和 `Cache-Control: no-store` 上传到 `dp-cdn-deepseek/harness/readme/`。脚本检查 OBS 响应状态、报告对应公开 URL，并在成功或失败后关闭客户端。仓库级 GitHub Actions Secret 提供 `OBS_DSH_README_ACCESS_KEY_ID` 和 `OBS_DSH_README_SECRET_ACCESS_KEY`；OBS 身份只需拥有该对象前缀的写权限。

资产仓库提供更新记录和回滚真源。图片替换后，公开 README 继续使用相同 URL，因此常规图片更新无需修改产品仓库或同步公开仓库。

## 曾考虑的替代方案

**继续在 `master` 上使用仓库相对图片。**这种做法只使用 GitHub 托管图片，但每次运营二维码替换仍与代码评审和公开仓库发布流程耦合。

**在产品仓库中保留长期资产分支。**资产分支可以避免修改产品 `master`，但图片所有权、OBS 凭证和发布工作流仍依附于产品仓库及其全仓自动化。专用仓库为这项运营资源提供单一默认分支和单一职责。

**使用内容寻址的 CDN 对象名。**不可变对象不会产生陈旧缓存，但每次替换图片还必须修改 README URL，无法提供此工作流所需的独立更新路径。

**允许上传脚本发布任意路径。**通用上传脚本可以在不改代码的情况下支持未来资产，但同一组凭证也能覆盖无关 CDN 对象。固定允许列表将发布任务限制在它负责的 README 图片内。

## 后果

社区二维码可以通过一次资产仓库 push 更新，公开 README 无需改变。产品仓库不携带 OBS 依赖或凭证；上传内容保留可审计的 git 真源；CDN 响应携带 `Cache-Control: no-store`。

README 依赖公开 CDN 和 GitHub 图片代理，发布流程则依赖另一个私有仓库及其 2 个 GitHub Actions Secret。`no-store` 为这些小文件放弃边缘节点和浏览器缓存。
