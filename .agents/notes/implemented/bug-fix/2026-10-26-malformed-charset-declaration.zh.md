# Agent Note: 畸形 charset 声明的恢复优先使用 UTF-8

Status: implemented

[English](2026-10-26-malformed-charset-declaration.md) | 中文

## Problem

响应可能在可读的 UTF-8 HTML 上声明 `charset=utf-8,gbk`。把整个参数交给 `TextDecoder` 会在读取前拒绝页面。兼容处理需要明确的编码优先规则，因为解码成功本身无法识别服务器原本使用的编码。

## Decision

`decoderForCharset` 保留合法的单标签声明，以及未声明时默认使用 UTF-8 的行为。如果整个声明不受支持，它检查按逗号和空白分隔的标签是否包含 UTF-8（含标准别名）。匹配时选择 fatal UTF-8 解码器；否则在读取正文前拒绝声明，由提供方取消响应流。

提供方只解码一次。恢复路径以 `WEB_UNSUPPORTED_CONTENT_TYPE` 拒绝非法 UTF-8，并保留解码错误作为 cause。只有真正触发字节上限截断时才启用流式解码，省略不完整的末尾序列并保持 `truncated: true`。完整响应（包括恰好达到上限的响应）在 EOF 校验末尾序列。

UTF-8 恢复是明确的启发式规则，不是原始编码的证明。字节 `C2 A9` 在 UTF-8 下表示 `©`，在 GBK 下表示 `漏`；重复这些字节后，任意长度都保留该歧义。提供方为 UTF-8 恢复接受这种歧义，但不将其扩展为任意传统编码的猜测。

## Alternatives considered

**选择声明中第一个能解码的编码。** GBK 正文也可能按 `windows-1252` 解出不同文本。声明顺序不能解决冲突，单字节编码还可能把解码失败变成静默的内容损坏。拒绝。

**先严格探测，再常规解码。** 这会对成功的正文解码两次。未结束的流式探测还会接受 EOF 处不完整的序列，随后被常规解码器替换。一次 fatal 解码配合显式截断状态已经足够。

**读取 BOM 和 HTML meta 声明。** 这会增加 HTML 编码识别能力及依赖或解析器，还需单独规定缺少元数据和非 HTML 内容的策略。继续延期；有范围的 UTF-8 优先规则可以处理所报告的响应，无需宣称与浏览器等价的编码检测。

## Consequences

- 含有 UTF-8 的畸形声明可以返回可读文本；UTF-8 恢复失败时不会回退到其他编码，也不会插入替换字符。
- 不含 UTF-8 标签的畸形声明仍不受支持，包括重复的传统编码别名。合法的单标签传统编码解码保持不变。
- [`fetch-http.spec.ts`](../../../../packages/web/web-fetch-http/tests/fetch-http.spec.ts) 覆盖恢复、冲突标签、非法字节、EOF、截断和响应流取消。
- 已录制的 [`web-fetch`](../../../../snapshots/session/web-fetch/snapshot.yml) 场景通过真实 HTTP 提供方，以 `charset=gbk,utf-8` 提供包含原样 UTF-8 字符的页面，并验证相同的模型可见文本。
- HTML `<meta charset>` 仍然被忽略。包 README 记录了剩余歧义。
