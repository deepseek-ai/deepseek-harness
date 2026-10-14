---
kind: upgrade-guide
description: "sdk-minimal 默认工具清单新增 read_image，并自动生成较早上下文的摘要。"
---

# SDK-minimal 图片读取与自动压缩

[English](guide.md) | 中文

## 变更

`sdk-minimal` 在持久 shell 和 `working_directory` 之外公布 `read_image`。上下文压力达到配置阈值时，自动压缩会额外发起模型请求，生成较早历史的摘要。完整 Session 日志仍存储为未压缩 JSONL。图片超出路由预算时会被永久替换为包含附件与路径的占位文本，以便重试请求。SDK 提示词文本不会执行 `/compact`。

固定工具名称、基准提示词大小或统计模型请求数的客户端必须考虑这些默认行为。图片读取需要适配器路由声明支持图片输入。配置与模型影响见[组合包参考](../../../../packages/bundle/sdk-minimal/README.zh.md)。

## 迁移

1. 接受新增默认能力，或将以下 patch 写入 `$DSH_HOME/profiles/sdk-minimal/cordis.patch.yml`，保留原有默认工具并关闭自动压缩：

```yaml
- id: tool-fs
  config:
    read: false
    readImage: false
    write: false
    edit: false
- id: compaction-basic
  config:
    auto: false
```

2. 启动新的 SDK 运行时。未额外配置用户插件时，模型请求包含持久 `bash` 或 `pwsh` 工具及 `working_directory`；不会发起自动摘要请求。
