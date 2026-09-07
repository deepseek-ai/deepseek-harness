# Agent Note: 配置面暴露什么，以及谁有权覆盖什么

Status: implemented
Archived: 2026-09-04

[English](2026-07-30-config-plane-boundaries.md) | 中文

> 范围：对 [Web 配置面](2026-07-30-web-config-plane.zh.md)的边界加固——哪些 namespace 能抵达协议、哪些调用方能抵达它们，以及一个只持有局部且可能陈旧的视图的编辑器该如何写入，才不会毁掉它看不见的东西。

> 调用方边界、脱敏与 revision 设栅依然有效。把「哪些 namespace 能抵达协议」限制为可配置提供方目录这一条，已被[由插件自己拥有的设置表层](2026-08-12-plugin-owned-settings-surface.zh.md)取代——后者服务每一个已注册的 namespace。

## 问题

这个面能用，但能触达它的调用方、以及它们所拥有的权限，都比设计声称的更多。

`trustedHosts` 只拦住了写入，因此一个已声明的 LAN 客户端可以调用 `settings.describe`——拿到每个已暴露 namespace 的配置——以及 `credentials.describe`，后者会报告任意一个环境变量名是否已配置、又从何处解析。那道 fence 是 DNS 重绑定防御，它自己也是这么写的；把它当作读取的授权边界，是一次范畴错误。另一件事是：代理服务于每一个已注册的 namespace。settings seam 是刻意做成通用的，因此第一个为自身配置调用 `settings.register()` 的插件，就会悄无声息地变成可远程读写，而完全不必经过任何针对 Web 表层的评审。

编辑器比「可触达」更糟——它是破坏性的。它读到的是脱敏后的 descriptor，后者按构造省略了 `role('secret')` 字段。清空其中一个字段，会用这份脱敏副本重建整个用户分节并发出 `settings.replace`，于是一个协议从未回传过的已存字面 `apiKey` 被顺带删除。这一点被直接复现：输入 `{baseURL, reasoning}`，输出时 `apiKey` 消失。删除整行走的是同一条路径。而且没有任何东西携带版本，因此两个标签页编辑同一个 namespace 会静默互相覆盖；seam 的逐 namespace 写队列只排定写入次序，分辨不出一个持有新鲜快照的写方与一个重放陈旧快照的写方。

另有三个较小的缺陷与之并列。`llm/adapters-updated` 的文档写着观察者失败会被收容，却只捕获同步失败，于是异步 listener 的 rejection 作为 unhandled rejection 逃逸。llm-deepseek 更换重试策略时，先对其注册执行 dispose（资源释放）、再重新注册，在两者之间发布了一个空路由集——观察者会看到该提供方消失又回来，尽管注释宣称不存在这样的空窗。还有，页面做凭据增强时的传输层 rejection 会逃出 `load()`，把页面卡在 `loading` 且不显示任何错误。

## 决策

**读取配置与写入配置同样属于特权操作。**`settings.describe`、`credentials.describe`、模型目录及其他所有 Host 操作都要求同一个浏览器会话。配置面仍独立于认证对 secret 脱敏。这条边界由真实 HTTP 服务器而非手工请求来断言，证明伪造 loopback `Host` 值绝不建立身份。

**这个面恰好服务于已注册模型提供方所指向的那些 namespace。**`ctx.llm.listConfigurableProviders()` 就是允许列表，于是产品边界是被执行的，而不是从已安装的插件集合里推断出来的；将来的 namespace 只有加入该目录才会变得可在 Web 上配置。未注册的 namespace 与未暴露的 namespace 得到完全相同的答复（`settings-not-exposed`），因此探测无法枚举注册表。

**持有局部视图的调用方，点名它真正要改的字段。**`SettingsProvider.mutate(ns, ops)` 会把 `set`/`unset` 路径 op 施加在写入排到队首那一刻的分节上。客户端通过对比自己打开时的快照与草稿来构造 op，因此它只提及自己看得见的字段：两侧都没有的机密不会产生任何 op，它的留存是构造使然，而非小心使然。`replace` 仍是那个刻意的整体重置。

**陈旧状态会被检测出来，而不是靠排序绕过去。**每个 namespace 都带有一个针对其**原始**分节的单调 `revision`；写入可携带 `expectedRevision`，不匹配即以 `SettingsConflictError` 拒绝——在协议上是 `settings-conflict`，并附上两个 revision。编辑器记住自己打开时的 revision，冲突时请用户重新打开，而不是把自己的快照重放上去。

**原始层拥有自己的事件。**`settings/updated` 仍以解析值为门槛——那才是消费方所说的"变化"。`settings/document-updated (ns, revision)` 则在任何原始分节变化时触发，因为配置界面必须知道某个字段从继承变成了覆盖（解析值相同，含义不同），也必须知道自己持有的 revision 已经过期。该事件被原样转发，模型消费方同时订阅它与 `llm/adapters-updated`，因为提供方设置持有不会由路由变化宣告的目录数据。

## 曾考虑的替代方案

- **在代理配置上做部署声明式的 namespace 白名单**——更通用，但它把产品边界交给了写 cordis.yml 的人，而空的默认值会让已交付的页面在每个部署显式开启之前直接失效。提供方目录本就精确地说明了哪些 namespace 属于模型配置。
- **在 `settings.register()` 处 opt-in metadata**——语义最正（由 namespace 的属主自行声明其暴露与否），改动也最大：seam 的公共接口、两个 LLM（大语言模型）插件，以及它们的文档。记录为：一旦某个非 LLM 的 namespace 确实需要这个面，就采用这个形状。
- **区分「未注册」与「已注册但未暴露」**——诊断更好，同时也是一台 namespace 枚举预言机。统一答复是刻意为之。
- **用 diff 而非 revision 来检测冲突**——对整分节写入而言，拿提交时的基线与存储比对是可行的，但编辑器持有的是**脱敏后**的分节：它给不出可比对的基线，这与它不能安全地 `replace` 是同一个原因。计数器两者都不需要。
- **在这里就修掉脱敏的缺口**——`redactSecrets` 只遍历 `object`/`dict`/`array`，因此藏在 union、intersection 或 transform 之后的机密会被原样返回，且 `secrets` 列表为空；`schema.toJSON()` 会带上 secret 字段的 `.default(...)`；写入拒绝的消息返回的是可能引用了输入的 schema 文本；客户端通过 schemastery 的 `new Function` 重建信封；而 pi-ai 那个纯字符串的 `headers` 字典完全可以合法地放下 `Authorization`。全部真实存在，也全部刻意留给一个 fail-closed 的 `describeForWire()`——它会拒绝自己无法证明安全的 schema。它们被记录为 `TODO(settings-wire-redaction)` 以及各属主 README 的 Known Limitations，而不是在这里做一半。

## 影响

`trustedHosts` 部署下的 LAN 客户端已经完全无法渲染设置页；配置表层就是回环。注册了 settings namespace 的插件，在它同时注册可配置提供方之前不会变得可在 Web 上配置——这是刻意的，也正是 `settings-not-exposed` 要在消息里点明这条边界的原因。`SettingsDescriptor` 新增了必填的 `revision`，因此以编程方式构造 descriptor 形状值的地方都必须提供它；`settings/document-updated` 是一个新事件，提供方侧的任何 listener 现在都可以观察它。忽略 `expectedRevision` 的客户端，其后写胜出的语义完全不变。延后事项：fail-closed 的协议 describe（连同它所承载的 `headers` 与信封净化工作），以及一套不含可执行代码的浏览器 schema 协议。
