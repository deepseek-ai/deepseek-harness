# Agent Note: 把 tool-owned render 移植到当前 DSH API

状态：proposed

[English](2026-08-27-port-tool-owned-render.md) | 中文

## 问题

`dsh-tool-owned-render` 原型（`Chinesezjc/dsh-tool-owned-render`）带有 `read`、`bash`、`write`/`edit`、`grep`/`glob`、`web_search`/`web_fetch` 的 tool-owned render 注册项，基于旧 API 编写：`ToolCallBlock` 暴露 `callView` / `resultView`，客户端能拿到 host `presentResult` 输出。当前 master 从原始 `block.call` / `block.content` / `block.meta` 推导客户端卡片，`ctx.slots` 也需要 `@deepseek-ai/dsh-client-ui-renderer/client` 模块增强。直接合并原型不能通过类型检查，因此这些注册项不经移植无法发布。

## 提案

- 新增 `packages/client/tool-owned-render` workspace 包。
- 把 `read`、`bash`、`write`/`edit`、`grep`/`glob`、`web_search`/`web_fetch` 注册项移植到从当前 `ToolCallBlock` 字段推导。
- 增加 `read_image` 注册项，使用同一套 ToolCard/Segment 原语。
- 通过 `dsh-client-ui-renderer` 接通 `ctx.slots` 类型增强。
- 移植单独推进，保持 PR #2828 可合并。

## 已考虑的替代方案

- **直接合并原型并就地修复类型错误** — 否决：每个注册项反正都要按当前 `ToolCallBlock` 字段重新推导，移植就是同一份工作，只是旧的 `callView` / `resultView` 契约已不存在。
- **把移植并入 PR #2828** — 否决：image 卡片是一个范围明确的单一功能，再加一个新包和五个注册项会扩大本已很大的 PR 的审查面。

## 验收标准

- `packages/client/tool-owned-render` 作为 workspace 包存在。
- 移植后的注册项从当前 `ToolCallBlock` 字段推导卡片状态，并在 master 上通过类型检查。
- `read_image` 注册项与 `read` 使用同一套原语渲染。
- `ctx.slots` 类型增强通过 `dsh-client-ui-renderer` 解析。
- PR #2828 独立于本移植合并。

## 风险

- 移植可能无法复现原型的精确视觉输出，因为当前卡片原语与旧的 `callView` / `resultView` 契约不同。
- 移植推进期间 API 继续漂移会使本提案过时；验收标准在移植时按当时的 master 重新核对。
