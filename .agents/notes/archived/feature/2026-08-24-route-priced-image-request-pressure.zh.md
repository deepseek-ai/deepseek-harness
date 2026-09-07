# Agent Note: 按路由定价的图片请求压力

Status: implemented
Archived: 2026-09-04

[English](2026-08-24-route-priced-image-request-pressure.md) | 中文

## Problem

token 计量服务把 `ImageBlock` 按其持久引用的 JSON 结构计价，约四十个 token，而一张 DeepSeek 请求图片最多消耗 384 个视觉 token，因此图片密集的会话可能携带数十万个未计入估算的 token。provider usage 只锚定已完成的请求：首次多模态请求、锚点之后新增的图片、offload 集合的变化，都会让自动 compaction 拿到数量级错误的压力值，触发得过晚（上下文溢出）或在路由切换后过早。[版本一简化](../simplification/2026-07-29-simplify-web-image-input-v1.zh.md)曾有意否决 provider-neutral 的 tile 公式，把视觉定价推迟到 provider-aware 估算器出现具体消费方之时。

## Decision

compaction 压力现在按路由模型自身的请求投影定价。`LlmAdapter.imageRequestPricing(provider, model)` 是可选的同步钩子，为一条确切路由返回 `LlmImageRequestPricing`，经 `ctx.llm.imageRequestPricing()` 解析；基类不声明定价，未注册的 provider 降级为 `undefined` 而绝不抛出。每个按序的图片出现处解析为一个 `LlmImageRequestPrice`：保留图片的提供方视觉 token，加上线上实际携带的模型可见文本（请求预览句柄、offload 占位文本或纯文本替换），文本交由调用方自己的估算器计价，避免任何提供方固定一种文本 token 化。

DeepSeek 适配器基于连接快照实现该钩子（`request-pricing.ts`）：未编目和纯文本模型把每个出现处按其 `textOnlyImageText` 替换计价；支持图片的模型通过共享的 `offloadedImagePrefixCount()` 复现序列化器第一阶段的最旧优先 offload，经序列化器同一套执行环境访问解析构建句柄与占位文本，并按 `requestImageDimensions` 投影尺寸用 `deepSeekImageTokens()` 为保留图片计价，后者是提供方公布的 v4 视觉计算器的逐句移植（14px patch、3:1 降采样、384 token 上限、最小像素放大、8:1 宽度钳制），按最坏的 pad-to-4 对齐计价。纯几何函数从 `attachment-local` 上移到 `dsh-attachment`，供提供方与定价共享。

token 计量服务的表层 fold 为每个节点存储与路由无关的事实：固定启发式价格、去图价格与持久图片出现处；`measure()` 在每次调用时按生效 envelope 的路由为表层定价。锚点保存原始材料（表层快照、提供方输出价格、usage）而非预先计算的基线，因此匹配的标头会把锚点与当前表层放在同一路由下重新定价，带符号 delta 的比较口径一致；usage 与估算的选择在每次计量时针对路由定价锚点做出。公开的 `TokenSurfaceNode` 同时携带 `tokens`（路由定价；触发、保留、选段与摘要收缩比较读取它）和 `heuristicTokens`（固定值；影子价协议的计量单位，使 `compaction/summary` 与 `compaction/prune` 与 O(1) 投影 fold 自身的追加保持一致）。`contextPressure` 与 `contextBreakdown` 投影有意保持固定启发式规则。

test-support 的回放适配器按模型声明固定的 `imageRequestTokens`，让 keyless 装配场景走通这条 seam；`image-compaction` ACP 快照证明六张内联图片把第二轮 pre-step 计量推过自动阈值，而纯文本启发式保持在阈值之下，且被触发的 compaction 按启发式价格遮蔽了图片消息。

## Alternatives considered

**在 provider-neutral 估算器里为图片定价。** 已被[版本一 note](../simplification/2026-07-29-simplify-web-image-input-v1.zh.md)否决且依然错误：视觉定价随提供方、模型、细节档位与预处理而不同，写死的数字在它不描述的路由上会显得权威却错误。钩子把每个常量留在拥有该路由的适配器里。

**只用 provider usage 校正压力。** usage 无法为首次多模态请求、锚点后新增图片或变化的 offload 集合定价，而这些正是让 compaction 触发过晚的情形。usage 仍是已完成请求的锚点；增量由路由投影定价。

**复现完整序列化管线，包括请求版本字节与 base64 回退预算。** 第二阶段 offload 依赖异步图片准备之后才存在的编码字节。定价复现由持久字节长度决定的确定性第一阶段；回退请求只会 offload 更多、花费更少，因此估算在同步无 I/O 的钩子里保持保守。

**让影子价协议也按路由定价。** 记录的 `shadowedTokenCount` 供 O(1) 投影 fold 消费，而该 fold 的追加按固定启发式计价；替换若按路由定价会让持久化的累计值漂移。协议保持在 `heuristicTokens` 上，维持 fold 的构造性一致。

**把路由定价并入计量服务的回放状态。** 绑定单一路由的 fold 在路由每次变化时都得重放，也无法回答指向另一模型的 `requestHeader` 覆盖。存储与路由无关的节点事实并在 `measure()` 时定价，保持单遍回放与契约已承诺的 O(surface) 计量。

## Consequences

自动 compaction 现在按路由模型下一次请求实际携带的压力触发：图片密集的 DeepSeek 会话在溢出之前而非之后压缩，纯文本路由收取替换文本而非幻影视觉 token，被 offload 的图片按占位文本计费。最坏对齐 pad 对单图最多多计三个 token，未复现的 base64 回退预算只会多计——两种误差都偏保守；执行环境访问路径若在定价与请求之间变化，只会按其自身长度改变描述文本的价格，请求完成后 provider usage 仍是权威锚点。公布的 v4 计算器常量只存在于 `llm-deepseek`；提供方若修订其视觉投影，改动点就是这一个模块与其钉死的向量。每次计量多一次定价解析与一次图片出现处遍历，仍为 O(surface)。

## Testing

`image-tokens.spec.ts` 的公式向量钉死公布计算器的输出，覆盖宽高比钳制、放大下限、单列求解、奇数网格裁剪与第二遍收敛的用例，开发期间与参考实现在尺寸网格及五万点模糊测试上对拍。`request-pricing.spec.ts` 覆盖纯文本替换、低细节预设以及数量与字节驱动的 offload 边界。token-meter 测试覆盖首次多模态估算、usage 之上的锚后图片 delta、标头覆盖下的纯文本重定价、无定价器时的中性行为、出现处数量不匹配与嵌套工具结果图片。compaction 测试证明触发、保留、选段与摘要收缩比较读取路由价格而记录的影子价保持启发式，包括一个只有路由定价收缩才接受的摘要。访问解析的传递在定价函数与适配器覆写两处都有覆盖。keyless 的 `image-compaction` ACP 快照端到端验证装配后的应用。
