# Agent Note: 单一 harness home 解析器

Status: implemented

[English](2026-07-24-single-harness-home-resolver.md) | 中文

## 问题

对于"DeepSeek Harness 用户数据存放在哪里"，harness 里存在两套互不一致的约定：

- `@deepseek-ai/dsh-home` 按 `configured ?? $DSH_HOME ?? ~/.dsh` 解析。
- `@deepseek-ai/dsh-home-paths` 又提供了**第二个** `resolveDshHome`，优先级相同但额外做了波浪号展开——它几乎是 `dsh-home` 的重复实现，却没有任何门禁发现，因为两者分属不同的包，而且早已漂移（只有一个会展开波浪号）。

同一条横切事实有两个解析器，意味着不存在单一的 home 策略。

## 决策

由一个解析器统一掌管 harness home，落在 `@deepseek-ai/dsh-home-paths`，采用单一根目录：

```
explicit configured path  >  $DSH_HOME  >  ~/.dsh
```

空或仅含空白的 `$DSH_HOME` 被当作未设置处理；否则，`resolve('')` 会悄悄把 home 落在当前工作目录。harness 把所有用户数据都放在同一个根目录下；不存在 XDG 的 config/data/cache 拆分。`dshHomePath(...segments)` 将部署负责的子路径拼接到该根目录下，`dsh-app-boot` 在挂载条目前向 Loader `!!js` 配置表达式暴露它，因此出厂组合无需复制解析器即可派生 `sessions` 和 `storages`。`dshHomeDisplay()` 为面向用户的路径以符号形式命名已解析的根目录——默认 home 显示为 `~/.dsh`，任何已配置的 home 显示为 `$DSH_HOME`——这样用户全局的 `AGENTS.md` 标签就绝不会泄露机器上的绝对路径。它取代了 agent-instructions 中自定义的「默认值 vs `$DSH_HOME`」判断。

`@deepseek-ai/dsh-home` 被删除。拥有 home 配置的提供方与 boot 包从 `dsh-home-paths` 导入 `resolveDshHome`；组合包只包含解析后的配置行。

`dsh-telemetry` 及其独立 home 策略已随 [SDK 项目工具链移除](../../archived/simplification/2026-08-11-remove-sdk-project-toolchain.md)一并消失，因此该解析器是唯一的 home 策略。

## 备选方案

**保留两份 `resolveDshHome` 副本。** 它们早已漂移（一个展开波浪号，一个不展开），并把同一条横切事实编码了两遍。`util/` 层的意义正是在于合并，重复的解析器是一个潜在的分歧 bug。

**采用 XDG（遵从 `$XDG_CONFIG_HOME`，或把 config/data/cache 拆分到各自的目录树）。** 经过考虑后放弃，转而采用一个显而易见的根目录。单一的 `$DSH_HOME || ~/.dsh` 基准事实与 `~/.claude` / `~/.aws` 一致，无需对每个 `~/.dsh` 消费方按类别重新归类，也不留下任何需要协调的解析器不对称。

## 影响

- 单一 home 事实，单一解析器。`dsh-home-paths` 是唯一归属方；`util/` 组失去了 `home` 包。
