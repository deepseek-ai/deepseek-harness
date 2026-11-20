---
kind: upgrade-guide
description: "“个性化推荐”可选 bundle 已移除；Web 组合自行挂载它的各行，默认开启，开关在“设置 → 通用设置”。"
---

# “个性化推荐” bundle 已移除

[English](guide.md) | 中文

## 变更

在 0.2.2-rc.4 中，在插件管理页开启“个性化推荐”会把 `@deepseek-ai/dsh-personalized-recommendations` 追加到 `$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles`。该 bundle 插入 `action-cards`、`client-ui-action-cards`、`creation-recommendations`、`client-ui-creation-recommendations`、`plugin-recommendations` 和 `client-ui-plugin-recommendations` 六行；没有开启它的 profile 不显示卡片。

下一版本移除该 bundle。`@deepseek-ai/dsh-web-app` 在每个 Web 和桌面端 profile 中以相同的 id 挂载这六行，因此默认会提供卡片。“设置 → 通用设置 → 个性化推荐”写入 `action-cards` 行的 `enabled`：关闭后，之后的请求不再列出这两个卡片 Skill，已经显示的卡片照常可用（[操作卡片](../../../../packages/interaction/action-cards/README.zh.md)）。

加载 profile 时会从其 `dsh.profile.bundles` 中删除 `@deepseek-ai/dsh-personalized-recommendations` 并重写 `package.json`；其他 manifest 字段保持不变。已有会话中的卡片保持原状态。

`cordis.patch.yml` 和 `--patch` overlay 中的行级覆盖继续生效。例如，`creation-recommendations` 上的 `disabled: true` 会阻止它注册 Skill，即使通用设置里的总开关已经开启。操作总开关不会启用被禁用的组件，插件管理页也不再提供旧 bundle 的组件开关。

## 迁移

1. 启动升级后的 profile 前，检查 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 和所有 `--patch` overlay 中针对上述六个行 id 的覆盖项。如需恢复全部组件，并通过通用设置的总开关控制推荐，移除其中旧的 `disabled: true` 字段。只有覆盖项仅含 `id`、可选的 `name` 和 `disabled` 时，才删除整个覆盖项；否则保留其他字段及 `config`。
2. 恢复组件后如需继续关闭推荐，在已有 `action-cards` 覆盖项中设置 `config.enabled: false`；没有该覆盖项时，再向 profile 的 `cordis.patch.yml` 加入 `- {id: action-cards, config: {enabled: false}}`。启动后，“设置 → 通用设置 → 个性化推荐”控制的就是这个值。
3. 用每个受影响的 profile 启动一次 `dsh`，自动移除已退役的 bundle 选项。由其他工具写入的 profile 目录需要自行从 `dsh.profile.bundles` 删除该条目。
4. 确认：`dsh.profile.bundles` 不再列出该 bundle，插件管理页不再显示异常的“个性化推荐”条目，且“通用设置”中显示“个性化推荐”开关。六个组件均已启用且总开关开启时，新建的普通模式对话能加载 `official-plugins` 和 `personalized-pages` 两个 Skill。
