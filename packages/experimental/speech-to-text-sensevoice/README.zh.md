---
description: "按需准备和运行本地 CPU SenseVoice 工作进程。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-speech-to-text-sensevoice

[English](README.md) | 中文

## 概述

此 Provider 在 Host CPU 上使用 SenseVoiceSmall ONNX 与 Silero VAD 识别语音。各平台的 sherpa-onnx Node 包包含 ONNX Runtime；用户无需 Python、编译器或模型转换。启用时检查缓存资源，不加载模型或下载资源。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

[Bundle](../voice-input-bundle/README.zh.md) 在 DSH 主目录下提供绝对 `dataRoot`。准备会下载固定修订的模型文件，校验大小与 SHA-256，再加载模型。`precision` 默认为 `int8`，`fp32` 选择较大的参考权重。`modelDirectory` 提供包含所选 ONNX 文件和 `tokens.txt` 的已有绝对目录，`vadModelPath` 选择已有 Silero ONNX 文件。取消或失败后复用已完成并通过校验的文件。

下载每个缺失文件前，Host 会比较兼容 Hugging Face 的 `modelOrigins`，默认为 `https://huggingface.co` 和 [HF-Mirror](https://hf-mirror.com)。并发 HEAD 请求沿用固定文件路径，通过 Host 的 fetch 代理跟随重定向，先返回 2xx 的源优先下载。`modelProbeTimeoutMs` 默认为 3000 毫秒；所有探测均失败时按配置顺序下载。网络、HTTP、证书或完整性校验失败会尝试其他源；取消、存储错误和未分类错误会停止准备。所有源都必须符合固定修订、大小和 SHA-256 校验值。响应延迟不代表下载吞吐量，完整下载仍受准备阶段的总超时约束。

显式 `modelOrigin` 仅使用指定源，不探测也不回退到公共源。只有一个地址的 `modelOrigins` 同样跳过探测。已校验的缓存和显式离线路径无需请求下载源。语音 UI 在准备或重试前提供已公布的下载源。手动选择仅覆盖本次任务，只使用指定源而不回退，且不能替换进行中任务的源。Host 拒绝配置之外的源；完全离线部署不公布下载源。

下载失败会标明文件与下载源，并提供原因分类，以及可用的 HTTP 状态或错误码。公开状态不包含 URL 凭据、查询参数和原始底层错误消息。重试复用已校验文件，未完成的文件重新下载。

每次启用都会检查磁盘上的所选模型、词表与 VAD。缓存完整且校验通过后立即恢复就绪，首次录音再唤醒工作进程。文件缺失或托管文件校验不符时需要显式准备；路径不可读时报告错误。显式部署路径只检查可访问性，文件内容由部署者负责。禁用插件或重启 Host 后，无需重新下载完好的缓存。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

一个托管 Node 子进程串行执行推理。唤醒期间提交的录音进入有界队列。工作进程在执行时要求资源处于就绪或待唤醒状态。转写不会启动准备下载。`threads`、`segmentSeconds`、`vadThreshold`、`minSpeechSeconds` 和 `minSilenceSeconds` 调节 CPU 推理与分段；`maxPending` 限制已接收任务数。准备和推理分别有截止时间。无效语言或 WAV 输入在原生推理前被拒绝，保留已加载的工作进程；推理失败、响应格式错误和传输失败会回收进程。取消会终止运行中的工作进程并等待其进程范围退出；已取消的排队录音不会执行。`idleTimeoutMs` 在空闲后释放进程，零表示保留至插件释放。模型继续保留在缓存中。带认证的环回请求仅在内存中保存音频。Electron 工作进程使用 Node 模式，并复制 VAD 缓冲区以兼容 V8 内存笼。`dsh-subprocess` 拥有进程范围观测；本包没有需要协调的独立投影，因此不发布不变量伴随模块。

Host 在页面和 Session 变化期间拥有准备任务：检查资源、下载识别权重与词表、下载 VAD、校验文件、加载工作进程。显式模型路径会省略对应下载步骤。下载报告字节，其他步骤报告等待时间。空闲进程保留已准备路径，唤醒时只需加载模型。准备结果发布后再取消，只等待任务收尾，不会覆盖该结果。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[语音输入子系统](../../../docs/subsystems/voice-input.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为录音与准备不进入模型请求；之后的文字由普通用户提交拥有。

#### KV 缓存影响

没有直接影响；普通提交拥有消息内容。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 仅使用 CPU。原生包面向 macOS arm64/x64、Linux glibc arm64/x64 和 Windows x64；Windows ARM64 与 Linux musl 尚非已验证部署目标。INT8 权重约 239 MB，FP32 约 938 MB，另需运行时和 VAD。模型内存大于文件大小，并随录音长度增长；安装提示属于估算。语言提示包括自动、中文、英语、粤语、日语和韩语。禁用插件保留模型缓存。桌面发行包仍需各平台签名和麦克风权限验收；Linux 桌面分发不属于此 Provider。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
