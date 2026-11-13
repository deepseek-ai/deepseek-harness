# Agent Note: PTC 工具执行仅支持 TypeScript

Status: implemented

[English](2026-11-12-typescript-only-ptc.md) | 中文

## Problem

Python 工具 SDK 最初让提供方能在保留类型化工具调用的同时更换程序语言。移除实验性 Python 运行时后，该呈现仍供外部提供方使用，并保留了 Python 完成值渲染以及施加于 Node 提供方的绑定命名限制。已发布 PTC 组合使用 TypeScript，因此这些路径维护着第二种语言，却没有仓库拥有的执行提供方或 profile 回放。

## Decision

`dsh-tool-executor-ptc` 仅支持 TypeScript。它移除 Python schema 渲染及导出、语言分发、完成值呈现与 Python 专属绑定排除规则。不支持的提供方在通过已选中的执行器组装提示词或执行程序时失败，也会在私有程序工具创建时失败。PTC 选择保持生效，避免无效提供方暴露继承的 native 工具。TypeScript 程序保留其 SDK、参数、显式输出选择、规范嵌套结果及取消行为。

运行时服务仍独立于工具。其源码语言描述符让每个消费方检查自身要求；直接运行时消费方与工作流消费方保留完成值。Harness Python SDK、运行时 wheel 与其他工具的 Python 环境有各自的消费方，继续受到支持。

[PTC 基础](../feature/2026-06-15-ptc.zh.md)与[类型化返回值](../feature/2026-07-20-ptc-typed-tool-returns.zh.md)仍因独立的分发、持久化及值语义而保持活跃。其中与语言有关的事实遵循本决定。[归档的语言分发决定](../../archived/feature/2026-07-31-ptc-language-dispatch.md)保持为冻结历史。

## Alternatives considered

**保留外部 Python 提供方支持。** 这在删除实现后保留了能力，但仍需要渲染器、另一套输出语义和跨语言命名限制。彻底移除使工具程序只有一种受支持语言，并提供明确迁移路径。

**同时移除 Python SDK 与运行时打包。** 这些包启动 Harness 并消费其公共协议，并不执行 Python PTC 程序。移除它们会丢弃独立的受支持客户端。

## Consequences

外部 Python PTC 组合必须迁移到 TypeScript 提供方并改写程序；[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.2/python-ptc-removal/guide.zh.md)拥有具体步骤。不提供 Python 兼容分支。重新引入需要有明确负责方的提供方、具体消费需求、语言专属的拒绝与输出测试，以及已发布 profile 回放。

拒绝测试通过 Cordis 挂载执行器与兼容选择器，再覆盖提示词组装、schema 投影、直接执行与私有工厂。构建导出检查固定 Python 渲染器的移除。现有免密钥 TypeScript profile 回放比较保持不变的模型提示和执行输出。绑定验证与真实进程执行覆盖不再需要 Python 排除规则的名称。已有 Session 日志和已提交历史代际逐字节保留。
