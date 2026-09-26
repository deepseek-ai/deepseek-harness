# Agent Note: 创造模式 skill 渐进式披露并允许读源码

Status: implemented

[English](2026-09-21-creator-skills-progressive-disclosure.md) | 中文

## Problem

出货的 `cordis-plugin-development` skill 把三个互斥的配方和一份验证清单放在一个 8.7 KB 的文件里，超过了标准 preset 工具结果修剪器只保留头尾的 8192 字符阈值。两个创造模式 skill 都禁止读取 DSH 包源码，使 skill 文本成为唯一知识来源，未覆盖的情况只能靠猜。skill 还用 `$DSH_HOME/profiles/<profile>` 指代 profile，而 agent 的 shell 从未拿到这个名字。

## Decision

`SKILL.md` 只保留流程、知识来源顺序和索引表；配方移入 `references/`，可复制的组合包移入 `templates/`，都通过 `skill` 工具已报告的 skill 基目录解析。一个测试保证开头文件在修剪器头部之内，并检查每个被引用的文件存在、每个模板可解析。

知识来源有顺序而不禁止：先通过 `cordis_inspect_query` 检查，再读 `Config.listConfigs` 经 profile 包查找解析出的 `packageDir` 下的包 README，仍有疑问时读构建后的 `lib/` 声明或 checkout 源码。自带包从 dsh 安装目录解析，profile 自行安装的包从 profile 解析，所以 skill 不再从 profile 目录推导包路径。启动器提供 profile 上下文时，shell 注册表把 `DSH_PROFILE` 与 `DSH_PROFILE_DIR` 作为保留内置变量暴露。

第三个 skill `cordis-composition-reference` 承载 Loader patch 方言和生成的可加载插件包清单，并在 `doc-sync` 中做新鲜度门禁，让流程 skill 不再增长。

## Alternatives considered

在系统提示里加创造模式文本每轮都要付费；skill 目录已能按需路由。把 `docs/` 出货给 agent 会把维护者材料稀释进需要安装态 profile 事实的运行时上下文。保留禁读源码则要求 skill 复述它可能需要的每一条声明。

## Consequences

首次加载 skill 约 3.9 KB，每个配方再加 1 到 3 KB。加载 `editing-cordis-compositions` 的录制会话在其文本变化时需要刷新。不带 profile 启动的组合没有这两个 profile 变量，skill 对此有说明。
