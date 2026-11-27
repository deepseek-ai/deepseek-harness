# G：通用

[English](general.md) | 中文

适用于本仓库全部代码以及本准则本身的规则。

<a id="g1"></a>
## G.1：每条规则都按标准格式编写

### 原因

固定格式让每条规则的要求、理由和适用范围都出现在同一位置。稳定编号让审查无需引述原文即可引用规则。

### 反例

```md
## Callbacks

Callbacks caused bugs before, so prefer other designs where possible.
```

没有编号，标题不是祈使句。要求埋在理由里，也没有说明如何发现违规。

### 示例

```md
<a id="g9"></a>
## G.9: <One imperative sentence>

### Reason
### Example, bad
### Example
### Enforcement
```

### 注解

一个规则分组是本目录中除 `README.md` 外、以分组命名的一对双语文件，例如 `general.md` 和 `general.zh.md`。其一级标题为 `<字母>：<名称>`，后接一段说明该分组范围的文字。`<字母>` 由一个或多个大写字母组成，在各分组之间唯一。[README.zh.md](README.zh.md) 列出全部分组和规则；新增规则时在同一变更中把它加入其中。

一条规则是所属分组文件中的一个二级标题 `<字母>.<n>：<标题>`。标题前放一个 `<a id>` 锚点，取值为去掉点号的小写编号。`<n>` 按添加顺序从 1 开始计数。删除的规则编号不再复用。

标题是一句陈述要求的祈使句。

正文是按以下顺序排列的三级标题。`原因` 和 `检查方式` 必需。`反例` 与 `示例` 至少给出一个。其他标题没有内容时省略。括号中是英文版的标题。

- `原因`（`Reason`）：规则防止的缺陷或代价。
- `反例`（`Example, bad`）：一处违规。
- `示例`（`Example`）：同一场景下合规的代码。
- `替代方案`（`Alternative`）：被禁止的写法应替换成什么。
- `例外`（`Exception`）：规则不覆盖的情形。
- `注解`（`Note`）：定义与细节。
- `检查方式`（`Enforcement`）：拒绝违规的检查，或审查者需要标记的情形。

句子简短直接。

### 检查方式

审查：标记偏离此格式的规则。`verify-translation-pairing` 拒绝两种语言版本结构不一致的分组文件。

<a id="g2"></a>
## G.2：避免在公共接口参数中使用回调

### 原因

- 难以阅读和推理。回调参数的类型没有说明被调用方何时调用它、调用几次，以及它抛异常时会怎样。
- 无法序列化。函数无法跨越进程边界，因此这样的接口不能作为 `@Remote` 方法或 SDK 方法。

### 反例

```ts
export interface UploadProgress { readonly loaded: number; readonly total?: number }

/** Upload `data`; `onProgress` runs for each chunk. */
export declare function upload(
  data: Uint8Array,
  onProgress?: (progress: UploadProgress) => void,
): Promise<string>
```

`onProgress` 会不会在 promise 落定后运行？它抛异常时会怎样？签名没有说明。

### 示例

```ts
export type UploadEvent =
  | { readonly type: 'progress'; readonly loaded: number; readonly total?: number }
  | { readonly type: 'done'; readonly fileId: string }

/**
 * Upload `data`. Yields one `progress` per chunk, then one `done`.
 * A failure rejects the next read; leaving the loop cancels the upload.
 */
export declare function upload(data: Uint8Array): AsyncIterable<UploadEvent>
```

顺序、失败和取消都遵循迭代协议。调用方的异常留在调用方自己的循环里。

### 替代方案

- 单个结果：返回 `Promise`。
- 中间结果，例如后续步骤之前创建的子项 id：把操作拆成由调用方按顺序发起的多次调用。
- 一系列值：返回 `AsyncIterable`。
- 面向任意数量监听器的通知：发出类型化 Cordis 事件，由消费方通过 `ctx.on()` 订阅。
- 可替换的策略或工厂：声明一个由提供方实现的 Cordis 服务。

### 例外

- 事件处理函数：调用方为接收事件而注册的函数或对象，例如 `ctx.on()` 的监听器（注册返回其 disposer），以及客户端组件的事件 prop，例如 `onClick`。传给处理函数的 waterfall `next()` 属于处理函数签名的一部分。
- 被调用方在调用返回或其 promise 落定之前就已调用完毕、异常会传回调用方、且不会保留的函数，例如比较函数或在锁内运行的任务。

### 注解

公共接口指包入口导出、Cordis 服务方法、`@Remote` 方法或 SDK 方法。

### 检查方式

审查：在新增或修改的公共接口中，标记任何不属于例外的函数类型参数，或选项参数中的函数类型字段。

<a id="g3"></a>
## G.3：新增规则如果能用脚本检查，同时加上门禁

### 原因

审查者会忘记规则，同样的违规就会再次出现。门禁自动拦住增量违规。存量违规记在一份列表里，所以规则立即生效，存量代码可以以后再改。

### 反例

```md
### Enforcement

Review: flag a direct assertion to `unknown`.
```

脚本能找出每一处直接断言为 `unknown` 的代码，这条规则却要靠每个审查者记住。

### 示例

```md
### Enforcement

`verify-no-unknown-casts` rejects a direct assertion to `unknown` that `scripts/no-unknown-casts.baseline.json` does not record.
```

### 注解

不需要人工判断就能找出违规的规则，可以用脚本检查，例如某种语法形式、某个导入或某种文本模式。需要判断的规则只靠审查，例如某个回调是否属于 [G.2](#g2) 的例外。

在新增规则的同一变更中：

- 加上门禁。列表没有记录的违规都会让门禁失败。
- 写出存量违规列表。没有命令能生成它。
- 在 `scripts/run-gates.ts` 中注册门禁。
- 在规则的 `检查方式` 中写明门禁名称。

列表中的条目不再匹配任何代码时，门禁也会失败。审查会拒绝向列表添加条目的变更，所以列表只减不增。

对 TypeScript 或 JavaScript 语法形式，基于 `scripts/baseline-inventory.ts` 编写门禁。它按文件和语法指纹记录每处违规，`--prune` 会删除不再匹配代码的条目。

### 检查方式

审查：标记能用脚本检查却没有门禁的新增规则。标记向门禁列表添加条目的变更。
