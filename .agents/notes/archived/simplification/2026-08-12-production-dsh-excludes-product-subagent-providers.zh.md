# Agent Note: 生产 dsh 排除产品 subagent 提供方

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-production-dsh-excludes-product-subagent-providers.md) | 中文

## 问题

`@deepseek-ai/dsh` 会获得 `@deepseek-ai/dsh-base` 的依赖闭包。如果 base 包含 Codex 与 Claude Code subagent 提供方，每次生产安装都会下载可选的产品集成代码与大型平台 CLI 载荷，即使用户并未使用任一集成。

## 决策

本决策只部分取代[共享 host 放置决策](../architecture/2026-08-10-product-subagent-providers-in-shared-host.zh.md)中关于默认包含提供方的部分：`@deepseek-ai/dsh-base` 不依赖也不挂载 Codex 与 Claude Code subagent 提供方。每个提供方包都是可直接安装的 Profile Bundle，其 `dsh.bundle.patch` 指向包自身拥有的 `cordis.patch.yml`。每份 patch 恰好贡献一条挂载自身提供方的 Host 行，不包含 Agent 工具行。

两个 Bundle 彼此独立。Codex Bundle 自己负责锁定的官方 wrapper 与六个平台 alias；生产环境会启动包所声明的 wrapper，绝不会回退到宿主 `codex`。Claude Code Bundle 自己负责锁定的 Agent SDK 与匹配平台 CLI；生产环境让 SDK 选择该私有 CLI，绝不会回退到宿主 `claude`。安装其中一个 Bundle 不会带入另一个，默认的 `@deepseek-ai/dsh` 生产依赖闭包既不包含任一提供方，也不包含任一产品运行时。每个已安装 Bundle 会在下次 Profile 启动时注册一个休眠提供方，而 Agent Preset 独立决定新 Session 是否获得对应工具。安装不会启动产品、验证账户、改写原生设置或向模型授予访问权。

## 验证

包测试会固定两个 Bundle 的 manifest、发布 patch、准确的自身提供方行与产品运行时依赖。Claude 覆盖会固定 Agent SDK 0.3.241、Claude Code 2.1.241、八个平台包、SDK 所选执行路径，以及载荷缺失时不回退宿主命令的失败。Codex 覆盖会固定 wrapper 0.149.1、六个平台 alias、包声明的执行路径、原生后代进程停稳，以及同样的载荷缺失行为。工作区验证会从 Bundle 声明派生每份发布 patch，而非维护包目录。包与 base 断言加上实际 pnpm 生产证据会证明默认与所选产品的依赖边界；真实 Bundle patch 与 Agent Preset 组装则覆盖未安装、任一单包、双包、工具授权交集、后续 Session 采纳以及零启动进程。

## 考虑过的替代方案

**在 base 组合包中保留休眠提供方。** 休眠提供方不会启动产品进程，但其包仍会进入每次生产 NPM 安装。

**新增 wrapper 或 meta Bundle。** 第三个包会重复安装责任，使独立移除变得更间接，却不会贡献新的运行时能力。

## 后果

安装 `@deepseek-ai/dsh` 时，不会通过 base 组合包下载任一产品提供方。Profile 可以独立添加或移除任一 provider Bundle；Host 可用性的变化会在下次 Profile 启动时生效，选择产品也代表明确接受其私有平台载荷。单独创作的 Agent Preset 仍只会向新组装的 Session 授予任一模型可见工具。本决策不会在产品官方发行版之外引入 wrapper 包，也不引入 meta Bundle、动态安装程序或持久化的产品启用状态。
