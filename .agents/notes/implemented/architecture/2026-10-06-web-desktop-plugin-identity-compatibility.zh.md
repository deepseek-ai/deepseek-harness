# Agent Note: 在实验能力整合中保留 Web 和 Desktop 插件身份

Status: implemented

[English](2026-10-06-web-desktop-plugin-identity-compatibility.md) | 中文

## 问题

把能力迁入 experimental 目录会改变其归属和支持分类。重命名已发布的包或既有配置行，还会改变已安装 profile 引用该能力的方式。这些身份变化可能要求正常工作的 Web 或 Desktop 自定义配置进行与能力行为无关的修改。

## 决策

迁移的包保留[实验包命名策略](../../../../scripts/experimental-package-policy.ts)声明的已发布名称。这个带类型的目录到包名映射是命名例外唯一手工维护的清单。包清单、消费者、安装检查和打包检查与其保持一致；缺失、迁移到其他位置或重复归属的例外会被拒绝。[实验状态](../../../../packages/experimental/README.zh.md#status)仍独立于名称拼写、Official 发现和显式选择。

既有徽章、Ralph 和原生委派行 ID 作为 Host 行选择器保持有效。新增隔离组和新引入的能力保留各自的新 ID。后续用户层仍可替换配置或禁用行。可选 bundle 仍须显式选择：指向缺失行的 patch 不会自动选择其 bundle。

兼容性保护覆盖 Web 和 Desktop profile，包括既有原生提供方的包身份、选择状态、配置和认证。原生 bundle 插入普通 Host 行，因此 Headless、SDK 和 ACP 组合也可以选择它们；不需要单独的仅提供方兼容包装包。公共 API 仍处于稳定前阶段，新增输出元信息保持必填，除非实际消费者需要适配。

## 暂缓的命名清理

| 保留的身份 | 不受兼容性约束时的清理 | 暂缓原因 |
|---|---|---|
| 命名例外映射中的已发布名称 | 为每个实验包使用 `@deepseek-ai/dsh-experimental-` 前缀 | 既有依赖、导入、模块声明和 profile 文件使用原有名称 |
| 既有徽章、Ralph 和原生工具行 ID | 为可选贡献统一使用独立的 `optional-*` 选择器 | 既有用户覆盖使用这些 ID；归属迁移不要求新的选择器 |

这些命名变更被暂缓，不是实验分类的前提。后续清理需要明确的发布与迁移决策、受影响 Web/Desktop 配置清单，以及已安装 profile 的升级验证。仅目录迁移或公共 API 处于稳定前阶段，不足以删除这些例外。包清单保留在带类型的策略中，不复制到本记录或各包 README。

## 考虑过的替代方案

**在整合时重命名所有包和配置行。** 统一拼写可以体现新归属，但会为本可保留引用的变更加上依赖和配置迁移。

**发布别名或保留重复兼容行。** 并行身份需要持续维护解析和移除规则，还可能重复注册同一能力。保留既有身份可以避免增加这种机制。

**通过额外包装包保留仅提供方 bundle。** 原生 bundle 插入普通 Host 行，可组合到任何 profile。额外交付包会保留选定兼容范围之外的组合，并增加目录和发布维护成本。

## 后果

仓库维护范围明确的命名例外映射，并测试通过直接导入、别名、传递依赖及打包产物识别这些保留名称。没有实验前缀的名称不因此获准进入默认产品。既有行身份具有覆盖用户配置和禁用状态的 Web/Desktop 组合测试。不引入通用别名或自动 profile 迁移机制。

[分类决策](../process/2026-10-05-product-package-classification.zh.md)、[可选组合决策](2026-09-21-experimental-capabilities-as-optional-bundles.zh.md)和[按需发现决策](2026-10-05-official-on-demand-bundles.zh.md)继续承担各自独立的职责。已发布 Session 代际和持久化 hook 事件名的保护独立于此 profile 兼容范围。
