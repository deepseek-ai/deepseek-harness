# DeepSeek 官方 LLM API 协议扩展

[English](deepseek-llm-api-wire-extensions.md) | 中文

本参考定义 [`@deepseek-ai/dsh-llm-deepseek`](../packages/llm/llm-deepseek/README.zh.md) 在 `deepseek-official` Messages 请求中发送的全部 DeepSeek Harness 专用 HTTP 标头与附加 JSON 字段。它不重新定义上游 DeepSeek API 自有字段。提供方无关的 LLM 接口与 `llm-pi-ai` 不实现这些扩展。

适配器将这些扩展发送至已解析的 `baseURL`，包括已配置的网关。扩展位于 `messages`、系统提示词和工具 schema 之外，因此不会增加模型输入 token，也不会改变模型可见前缀。

## 协议命名空间与版本

| 位置 | 命名方式 | 示例 |
|---|---|---|
| HTTP 字段名 | 小写 kebab-case；HTTP 匹配仍不区分大小写 | `user-agent`, `x-deepseek-harness-session-id` |
| DeepSeek 请求正文扩展字段 | 使用保留 `dsh_` 前缀的 snake case | `dsh_plugin_packages`, `dsh_session_log` |
| DSH 持有的嵌套 JSON 成员 | Camel case | `afterSeq`, `throughSeq`, `sessionId` |
| 带标签的值 | 使用 kebab-case 字符串；持久事件采用 `domain/action` | `session-log-deepseek/delivery-accepted` |

每个正文扩展独立持有自身的 `version`。版本仅适用于包含该字段的对象；不同字段的版本之间不存在兼容或排序关系。JSON 成员顺序不属于协议。

[`DeepSeekLlmApiExtensionRegistry`](../packages/llm/deepseek-llm-api-extensions/README.zh.md) 为每个顶层扩展名保留一个提供方。空名称、两端带空白的名称、重复注册以及与 DeepSeek 基础请求冲突的名称都会在 HTTP 分派前失败。

## 请求标头

| 标头 | 出现条件 | 值 |
|---|---|---|
| `user-agent` | 每个提供方 HTTP 请求，包括 Files API 操作 | 采用 `product/version (+url)` 形式的应用身份；默认产品为 `deepseek-harness` |
| `x-deepseek-harness-user-id` | 每个已授权的模型请求 | 已解析 Harness home 的稳定匿名 UUID |
| `x-deepseek-harness-session-id` | 携带会话 id 的模型请求 | 确切的请求 `sessionId` 字符串 |
| `x-deepseek-harness-compact` | 用途为 `compaction` 的模型请求 | 字面字符串 `1` |

凭据失败发生在解析匿名用户 id 之前，因此未授权请求既不会发送这些标头，也不会创建身份文件。没有会话的直接请求会省略 `x-deepseek-harness-session-id`。会话标题请求没有额外的用途标头；请求携带 `sessionId` 时，仍然适用普通的会话 id 规则。

## 正文扩展事务

适配器先序列化包括确切 `messages` 在内的完整基础正文，再让已注册提供方准备字段。提供方会收到该不可变正文、请求取消信号，以及可选的 `sessionId` 和辅助调用 `purpose`。提供方返回 `undefined` 时，本次请求会省略其字段。

系统将已准备的 JSON 值与提供方持有的状态分离，再将其作为基础字段的顶层同级成员合并，并序列化到同一个 HTTP 正文中。准备失败或冲突会阻止请求。合并后的正文无法序列化时，适配器发送不含任何扩展字段的基础正文，跳过接受事务，让贡献方在之后的请求中重发自身状态，并记录被省略的字段名。组合未挂载注册表时，适配器发送未经扩展的基础正文。

已配置端点返回 HTTP 2xx 后，适配器会在读取 SSE 正文之前运行已准备的 `accept()` 事务。传输失败和非 2xx 响应不会接受任何贡献。即使端点返回 2xx，接受失败仍会使模型请求失败。接受仅记录端点级 HTTP 成功，不表示 SSE 流已完整结束，也不表示端点已持久化扩展。

## `dsh_plugin_packages`

[`@deepseek-ai/dsh-plugin-package-inventory-deepseek`](../packages/llm/plugin-package-inventory-deepseek/README.zh.md) 贡献完整存活的 Loader-backed 插件包清单。该字段默认启用。

```json
{
  "dsh_plugin_packages": {
    "version": 1,
    "packages": [
      {
        "name": "@deepseek-ai/dsh-example",
        "version": "0.1.1-rc.2"
      }
    ]
  }
}
```

| 成员 | 类型 | 含义 |
|---|---|---|
| `version` | `1` | `dsh_plugin_packages` 的 schema 版本 |
| `packages` | 数组 | 本次请求的完整存活集合 |
| `packages[].name` | 字符串 | 来自所属 manifest（元数据清单）的确切非空 npm 包名 |
| `packages[].version` | 字符串 | 来自同一 manifest 的确切非空包版本 |

每个请求都会重新读取宿主树中的存活非分组 Loader 配置项；请求会话存在 standing agent-preset 树时，也会读取该树。相对与绝对模块使用距离自身最近的所属 manifest；裸包配置项使用激活自身的 Loader 解析基准。具名 manifest 未提供非空版本时，请求准备会失败。

发送方会对确切 `(name, version)` 组合去重，并使用与 locale 无关的文本比较，先按 `name`、再按 `version` 排序。同一包的多个同时存活版本会保留为独立配置项。接收方不得按包名折叠该数组，也不得根据数组顺序推断包的激活关系。

该清单不包含已禁用、pending、failed、unloading、disposed 和结构性 Loader 配置项。普通依赖、没有具名所属包的松散模块、以编程方式挂载的子 fiber，以及内存动态插件也不在其中，因为它们没有权威的 Loader 包来源信息。

清单已启用但没有符合条件的配置项时，系统发送 `packages: []`；禁用贡献插件时，系统省略整个 `dsh_plugin_packages` 字段。包身份属于提供方元数据，绝不进入模型输入。

## `dsh_session_log`

[`@deepseek-ai/dsh-session-log-deepseek`](../packages/session/session-log-deepseek/README.zh.md) 贡献权威会话日志的一段连续后缀。该字段默认启用。它适用于携带存活会话且至少存在一个事件的请求；直接请求、陈旧会话 id 或空日志会省略该字段，第一条待发事件本身超过 `maxBytes` 或无法序列化的请求也会省略该字段；组合可用 `enabled: false` 禁用它。下方示例使用逻辑 Session 格式 2 仅为说明协议字段，并不标识[当前写入格式](session-format-status.zh.md)。

```json
{
  "dsh_session_log": {
    "version": 1,
    "sessionFormatVersion": 2,
    "session": {
      "version": 2,
      "id": "session-id",
      "createdAt": 1780000000000
    },
    "afterSeq": -1,
    "throughSeq": 0,
    "events": [
      {
        "type": "turn/start",
        "seq": 0,
        "time": 1780000000001,
        "data": {
          "turn": 1
        }
      }
    ]
  }
}
```

| 成员 | 类型 | 含义 |
|---|---|---|
| `version` | `1` | `dsh_session_log` 的 schema 版本 |
| `sessionFormatVersion` | 非负整数 | 该后缀所表示的 Session 格式 generation |
| `session` | 对象 | 当前 Session header 的不可变协议投影 |
| `afterSeq` | 整数 | 本次请求前记录为已接受的最大序号，或 `-1` |
| `throughSeq` | 非负整数 | 本次请求所表示的最大序号 |
| `events` | 数组 | 从 `afterSeq + 1` 到 `throughSeq` 的连续事件 |

首次上传使用 `afterSeq: -1`，此后每次上传都从同一会话 id 的最大已接受水位（watermark）之后开始。每次上传携带从该位置起、序列化后能放进 `maxBytes` 的最长连续事件段；`maxBytes` 默认 8 MiB，按 UTF-8 字节计算，包括 header 与数值字段，因此超过上限的积压会分多次已接受的请求传完。发送方为每次请求仅快照一次事件数组；快照后的追加内容属于后续请求。

### Session 协议 header

`session` 成员将逻辑 Session 元数据投影为原始 JSON 基元。seeded Session 以 `seedLength` 发送确切的 `Session.inheritedEventCount`；未 seeded 的 Session 省略该字段。逻辑 `isSeeded` 标志不出现在此协议中。外层 `dsh_session_log.version` 选择本扩展 schema，`session.version` 则选择逻辑 Session 格式。即使嵌入的逻辑格式同时变化，只要 Session header 投影变化，扩展 schema 也必须升版。

| 成员 | 出现条件 | 含义 |
|---|---|---|
| `version` | 必需 | 来自 `Session.header` 的逻辑 Session 格式版本；见[格式状态](session-format-status.zh.md) |
| `id` | 必需 | 确切的会话 id |
| `createdAt` | 必需 | 非负安全整数 Unix epoch 毫秒数 |
| `cwd` | 可选 | 创建会话时记录的绝对工作目录 |
| `parentSession` | 可选 | fork 的父会话 id |
| `seedLength` | 仅 seeded Session | 确切的继承事件数量；空的继承前缀使用零 |
| `origin` | 可选 | subagent 子项使用的字面值 `subagent` |
| `delegationDepth` | 可选 | 持久化的非负 subagent 委派深度 |
| `agentPreset` | 可选 | 用于组合该会话的 agent preset id |

### 权威事件信封

每个 `events` 元素以原始 JSON 基元承载规范事件，不依赖任何其他请求字段。每个事件包含 `type`、数值型 `seq`、`time` 与 `data`，存在 `ignorable: true` 时保留该值。表层事件必须携带 `surfaceOp`；替换范围使用数值型 `startSeq` 与 `endSeq`，system、user 和 tool 事件还可携带数值型 `sourceEventSeqs`。assistant 的提供方元数据保留在内嵌流中。已知的仅日志事件省略表层元数据；恢复的未知可忽略记录保留不透明元数据，但不将其解释为表层操作。

### 接受水位与至少一次交付

端点返回 HTTP 2xx 后，该贡献会向同一会话追加以下权威事件：

```json
{
  "type": "session-log-deepseek/delivery-accepted",
  "seq": 8,
  "time": 1780000000002,
  "data": {
    "sessionId": "session-id",
    "sessionFormatVersion": 2,
    "throughSeq": 7
  }
}
```

`delivery-accepted` 表示已配置端点为包含该字段的 LLM 请求返回 HTTP 2xx。它不表示 SSE 已完整结束，也不表示远端已经持久化。该事件的 `throughSeq` 必须标识一项更早的事件，`sessionId` 标识已发送后缀所属的 Session，`sessionFormatVersion` 则把水位绑定到该逻辑 generation。缺少该字段表示历史格式 v0。

发送方只会为当前 Session id 与格式 generation 折叠最大的匹配 `throughSeq`，因此并发已接受请求无法使游标倒退，其他 generation 的水位也不能授权当前后缀。恢复后的进程会从持久日志重建游标。fork 会忽略命名其他 Session 的继承水位，因此从序号零开始、按 `maxBytes` 分多次请求上传自身的继承前缀，再以子会话 id 推进。水位事件自身属于下一段未发送后缀。

传输失败、非 2xx 响应，以及序列化失败后不带扩展字段发出的请求，都不会追加水位。端点接受后、本地持久化前发生崩溃时，系统可能重新发送已接受范围；不确定性只会产生重复，绝不会产生序号缺口。系统没有独立上传存储或截断路径；`maxBytes` 负责限制每次请求的字段大小。

## 暴露内容与接收方要求

请求标头会暴露 Harness 应用版本、一个匿名 Harness-home 身份和可选的会话身份。`dsh_plugin_packages` 会暴露存活 npm 包的名称与版本。除非组合禁用该字段，`dsh_session_log` 可能暴露会话工作目录、系统提示词快照、用户与 Assistant 内容、嵌入式 Assistant stream、失败 attempt 输出、工具参数与结果、压缩摘要、反馈和插件持有的事件。适配器 API key 不是会话事件，因此不会进入该字段。通过 `baseURL` 选择的网关会收到与官方端点相同的值。

接收方按名称定位扩展字段，按各字段自己的 `version` 分派，保留不同的包版本，并忽略 JSON 成员顺序。会话日志接收方必须先校验连续序号范围，再解释事件类型。遇到不带 `ignorable: true` 的未知权威事件时，接收方无法进行无损重建。即使缺少注册表或某项贡献，基础请求仍然可用；字段缺失表示该项贡献不适用于本次请求。会话日志积压补传期间，`throughSeq` 落后于会话的最新事件，因此 2xx 并不表示接收方已持有当前完整日志。
