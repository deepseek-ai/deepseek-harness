---
description: "使用 SQLite 持久化会话，并在打开时导入已有 JSONL 历史。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-sqlite

[English](README.md) | 中文

## 概述

将新会话存入 SQLite，并在首次打开旧 JSONL 会话时导入历史。调用方继续使用原有会话持久化 API。源 JSONL 文件保留在磁盘上。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

对于基于 `dsh-base` 的配置方案，在全局 `$DSH_HOME/cordis.patch.yml` 中选择此提供者：

```yaml
- id: session-persistence-jsonl
  disabled: true
- insert:
    - id: session-persistence-sqlite
      name: '@deepseek-ai/dsh-session-persistence-sqlite'
      config:
        root: !!js dshHomePath('sessions')
```

独立的 `sdk-minimal` 配置方案将 JSONL 加载项命名为 `sessions`；在其方案补丁中使用这个 id。所选提供者注册 `ctx.sessionPersistence`。默认发布的配置仍使用 JSONL。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 会话根目录；数据库位于 `<root>/.segments/sessions.sqlite` |
| `compression` | `zstd` | 旧 JSONL 读取器使用的编码；SQLite 事件是未压缩的 JSON |
| `listConcurrency` | `3` | 旧历史元数据读取的最大并发数 |

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>存储与迁移</summary>

SQLite 插件依赖 JSONL 包来读取历史并完成相邻版本迁移。隔离的 JSONL 读取器不会替换应用的 SQLite 持久化服务。`stat()` 和 `list()` 查看元数据；打开旧会话时，将完整逻辑历史导入一个根 Segment。并发读取者共享导入过程，写访问沿用单写入者所有权规则。源文件保持不变。

提供者启动与卸载位于[插件入口](src/index.ts)；[迁移](src/migration.ts)协调导入，[持久化](src/persistence.ts)提供原有 API。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [会话持久化 API](../session-persistence/README.zh.md)
- [JSONL 存储](../session-persistence-jsonl/README.zh.md)
- [历史格式迁移](../session-format-catalog/README.zh.md)

<a id="model-experience"></a>
## 模型体验

### 持久化历史

#### 模型看到什么

此插件不添加请求内容。会话使用方通过 `ctx.sessionPersistence` 读取保存的逻辑事件历史。

#### Token 影响

没有直接 Token 影响。

#### KV Cache 影响

存储介质不会改变逻辑事件历史，也不会添加模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 重新选择 JSONL 不会把 SQLite 历史导出到保留的 JSONL 文件。

### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
