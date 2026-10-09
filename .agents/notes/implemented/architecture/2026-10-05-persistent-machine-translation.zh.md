# Agent Note: 机器翻译结果使用统一的 Session 记录

Status: implemented

[English](2026-10-05-persistent-machine-translation.md) | 中文

## 问题

读者在重新展开思考内容或重启应用后仍需要已保存的译文。只在展开区域缓存会重复外部请求、可能改变已显示结果，也可能重复产生模型费用。仅存储模型输入无法在重启后恢复成功译文。

## 决策

translator 对所有 Provider 统一使用 `plugin:translator/request` 和 `plugin:translator/result`。请求记录所选 Provider、精确原文、源语言和目标语言，以及翻译规则标识。可选 metadata 保存 Provider 自有请求细节。结果引用请求的 Session 序号并保留完成后的译文。请求在派发前持久化，结果在返回 GUI 前持久化。

浏览器将展示翻译绑定到展开区域的 Session，Host 校验配置的提供方和显式目标语言。已认证的 Client 提供原文与 Session 身份；Host 不校验原文是否属于该 Session。成功记录可跨展开组件生命周期和重启复用。身份包含 Provider 和翻译规则，因此改变接收方、语言或翻译设置不会混用其他结果。相同的并发翻译等待同一结果，不同片段可并行执行。

只读查找先于 Provider 调用。新记录通过已激活 Session 的现有写入器调用 `appendPluginRecord` 并定向刷新。未激活 Session 缓存未命中时，在 Provider 调用前拒绝；GUI 消费者等待 Session controller 的正常激活，再重试一次。

这些记录与[原始思考内容](2026-10-05-anonymous-reasoning-translation.zh.md)一同保留，从不替换其事件或模型输入。它们使用现有的实验性记录写入器，格式迁移采用尽力保留语义。Provider 可用性限制新请求，已保存结果无需再次推理即可读取。不指定 Session 时，translator 仍支持无状态调用。

## 考虑过的替代方案

**只保留展开区域内的结果。** 重新展开会丢失已展示值并再次发送同样的文本，可能重复计费。

**匿名翻译与模型翻译使用不同的结果格式。** 读者对所有 Provider 都需要相同的原文到译文关系。Provider 自有审计细节属于可选 metadata。

**替换原始 assistant 思考内容。** 翻译属于派生数据。与原文并存可以保留模型历史和原文访问能力。

**为历史翻译另开写入器。** 这会与正常 Session 激活竞争，并需要协调两个写入所有者。GUI 已经会激活打开的对话；使用其现有 controller 可将所有权集中在一处。

## 后果

Session 在原始思考内容之外保留译文和请求身份。只有完成并持久化的结果提供缓存译文，失败或未完成尝试不提供。已进入 append-only 日志的完成记录可能在调用者迟到取消后保留。记录不引入已发布的 Session schema 历史，未来格式迁移可能丢弃实验性状态。

已保存结果无需激活即可读取。新翻译可能等待正常 Session 激活，包括 preset 启动钩子、恢复标记、中断轮次修复及所需的 generation 迁移。这些普通生命周期行为可能追加上下文；翻译不会绕过它们。缓存读取不会发布旧 generation。translator 不拥有第二个写入器，也不需要修改核心生命周期。
