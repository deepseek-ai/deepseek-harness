# Agent Note: 校验已发布文档的 fragment

Status: implemented
Archived: 2026-09-04

[English](2026-08-13-published-document-fragments.md) | 中文

## Problem

`verify-md-links` 使用 GitHub 的 Markdown 标题 id 校验 fragment，而文档网站使用 VitePress 渲染标题。包含较多标点的标题与翻译后的标题可能通过源码校验，却在已发布 HTML 中没有对应 id。VitePress 构建成功只会校验目标页面，不会校验 fragment id。

## Decision

`docs:build` 及其 MPA 变体会在 VitePress 生成 `website/.dist` 后运行 `verify-doc-site-fragments`。该校验器解析每个生成的 HTML 页面，按照 VitePress clean URL 解析每个内部 fragment 链接，并在构建产物不存在、路由有歧义、href 格式错误、目标页面不存在或请求的 id 缺失时失败。单元测试覆盖这些失败，以及 clean URL、`.html` 别名、同页链接、编码和字面 id 与外部链接排除。

任何 GitHub id 与 VitePress id 不同的 fragment 目标标题都会带有与 GitHub 兼容的显式别名。英文手写页面和翻译页面会在标题前添加别名；翻译页面使用双语对侧文件共享的英文 id。生成的配置、工具和持久化目录由所属生成器输出别名。源码 Markdown 校验保持独立，仍会拒绝在仓库渲染规则下无法解析的链接。

目标存在配对文件时，文件路径按照[双语文档链接本地化决策](2026-08-18-localized-bilingual-links.zh.md)跟随源文档 locale；配对两侧仍使用完全相同的 query 与 fragment 后缀。

## Alternatives considered

**使用各语言专属的 fragment。** 配对文件路径会跟随源文档 locale，但双语两侧仍刻意保留相同的 fragment 后缀。语言专属 fragment 会要求每个链接生成方都了解目标语言翻译后的标题。

**依赖 VitePress 标题 id。** 这些 id 取决于渲染后的标点与本地化标题文本，无法保留仓库链接和生成引用已经使用的 GitHub id。

**只检查 Markdown 源码。** 这种做法不会校验发布产物，也无法发现 GitHub 与 VitePress slug 算法之间的差异。

## Consequences

每次生产文档构建都会读取一次生成的 HTML，在现有网站构建后增加一个有界检查。跨页面 fragment 链接必须指向发布后仍存在的 id。显式别名成为已发布参考的一部分，使标题更换语言或标点后仍能保留既有 fragment。
