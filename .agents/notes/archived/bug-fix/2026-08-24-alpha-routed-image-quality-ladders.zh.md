# Agent Note: 按 alpha 路由的图片质量阶梯取代按色数分类的编码路由

Status: implemented
Archived: 2026-09-30

[English](2026-08-24-alpha-routed-image-quality-ladders.md) | 中文

## 问题

`@deepseek-ai/dsh-attachment-local` 的图片规范化和请求版本编码此前按 5-bit 色数采样选择编码器：128×128 最近邻采样量化后不超过 256 色的图片先走 palette PNG（libimagequant）再退 WebP，其他透明图片走 WebP，其他不透明图片走 JPEG。高频摄影类 JPEG 的量化采样经常落在阈值以下，issue #2885 的 8000×8000 复现图片采样色数为 175 和 184，实际色数为 2145 和 4077，而 palette PNG 是管线里最慢的编码器，在这类内容上产物还比 JPEG 大约 4 倍（2048px master 尺寸实测 2657ms/3.95MiB 对 26ms/0.95MiB）。采样本身因 `fastShrinkOnLoad: false` 必须全尺寸解码，64MP 源图上每张都要付出 86 至 192ms。当所有候选都超过字节上限时，两个编码器还会进入按比例缩图重试的循环，最终以 `IMAGE_TOO_LARGE` 报错，而实测最坏输入（均匀噪声）在默认预算下第一档质量就能装下。

## 决定

两个编码器只按一个解码事实路由：带 alpha 通道的源图编码为 effort 0 的有损 WebP，不透明源图编码为 JPEG（libjpeg-turbo），共用质量阶梯 85、75、60（`encoding.ts` 的 `IMAGE_ENCODING_QUALITIES` / `WEBP_ENCODING_EFFORT` / `encodingLadder`）。色数分类器和 palette PNG 分支被删除而不是修复，误判这一 bug 类别因此不可能复发，也不再有图片付出分类解码成本。`normalizedImageMaxBytes` 和路由 `maxBytes` 的语义从上限改为阶梯目标：阶梯仍在第一个装得下的质量档停下，但全部档位都超过目标时保留最小产物，缩图重试循环被删除。提供方字节硬限制（DeepSeek 单图 32MiB、inline 预算）仍在传输字节的位置执行。master 尺寸规则从长边上限改为总像素预算：`normalizedImageMaxPixels`（默认 2048×2048）按比例缩放，`normalizedImageMaxDimension`（默认 8192，与准入单边上限一致）随后夹住长边，因此长页面截图这类极端长宽比保留短边分辨率（2000×20000 的源图短边保留约 647px 而不是 204px），正方形源图的规范化结果与之前完全一致。请求变换版本升到 `request-image-v5`，已有变体缓存按身份自然重建；内容寻址的 master 无需迁移，继续有效。请求缓存读取不再拒绝超过字节目标的条目，因为阶梯耗尽的产物就是该 variant id 的确定性结果。

对 issue #2885 复现集的 Pareto 实测（PR #2989 附录）支撑这个选择：摄影类内容上 JPEG 比其余所有编码器快 1 至 2 个数量级，effort 0 的 WebP 在图形类内容上体积与 palette PNG 相当且不会被误判；均匀噪声最坏输入在不透明链的 q85 一档即落入默认 4MiB/1MiB 目标，只有对抗性的随机 alpha 平面会耗尽 WebP 阶梯（约 6.3MiB，距提供方上限还有 5 倍）。

本决定部分取代[统一图片请求管线记录](../feature/2026-08-20-unified-image-request-pipeline.zh.md)：其规范化与请求编码章节现在以本路由为准；其耐久版本拆分、Files 生命周期与卸载投影不变。

## 考虑过的替代方案

**修复分类器（提高采样分辨率、加入梯度统计）并保留 palette PNG。** 否决：任何内容分类器都保留一类误判和每张图的分类解码成本；palette PNG 唯一的前沿生态位（图形类）WebP 用远少的编码时间即可达到。

**全部走单一 WebP 阶梯。** 否决：JPEG 在不透明摄影内容（真实负载的大头）上快 4 至 6 倍，而 alpha 探测只是零成本的元数据读取。

**为阶梯耗尽的产物保留缩图重试循环。** 否决：实测最坏情况表明该循环在默认预算内是死代码，其唯一可达效果是把对抗性输入一路缩到 1×1 再报错。

## 后果

- 不透明的低色数图形（图表、文字截图）现在存为 JPEG：在几百 KB 量级上比 palette PNG 大 2 至 3 倍，锐利边缘有 JPEG 振铃；模型可见的请求版本本就被像素预算缩尺寸主导，可读性影响很小。将来若需要图形类专用编码，正确做法是给不透明阶梯加一档 WebP，而不是恢复分类。
- GIF 源图经 gifload 解码后带 alpha 平面，因此静帧 GIF 规范化走 WebP 阶梯。
- `IMAGE_TOO_LARGE` 不再产生于编码环节；它仍是超大源图的准入错误。
- 阶梯耗尽的附件可能以超过字节目标的大小落盘和上行，直到提供方上限拒绝；实测只有对抗性随机 alpha 输入可达。把这样的超目标 master 再次作为新上传提交时，直通的字节检查不通过，会再走一遍有损阶梯，因此规范化对这一仅对抗性可达的类别不幂等，每轮都会累积代际损失。
- 测试证据：`packages/attachment/attachment-local/tests` 用真实编码器钉住路由、阶梯耗尽和文字可读性行为，包括 issue #2885 误判特征（高频摄影内容离开慢路径）。
