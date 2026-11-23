# Agent Note：带自动选择的 DeepSeek 云端语音识别

Status: implemented

[English](2026-11-04-deepseek-cloud-speech-recognition.md) | 中文

## 问题

实验性语音输入只在 Host 上识别，首次使用必须下载并准备本地模型。有 DeepSeek 凭据的用户应能免去这一步直接听写，没有凭据的用户仍可使用本地识别。DeepSeek 以 `POST /v1/tools/asr` 提供语音识别，它与其他 DeepSeek 接口一样接受账号登录和 API Key，而 DeepSeek 使用方如何鉴权由 [`ctx.deepseekAuth`](../architecture/2026-11-10-deepseek-request-authentication.zh.md) 负责。[语音输入决策](../architecture/2026-09-16-experimental-voice-input.zh.md)禁止本地失败后回退上传语音。

## 决策

独立的 Provider 包 `speech-to-text-deepseek` 以 `location: 'cloud'` 注册 `deepseek-asr`，把每段完整的 WAV 录音原样发送到 `/v1/tools/asr`，不使用流式识别。它是 `ctx.deepseekAuth` 的使用方，接受两种凭据，先用账号登录再用 API Key：除非部署另行配置，账号所属的部署就是官方部署，而 API Key 常常对应自定义 endpoint。只要配置了任一种凭据就处于就绪状态，不探测 endpoint：没有 `/v1/tools/asr` 的自定义 endpoint 会让每次录音失败。账号服务与 `deepseek-auth` 都不改动。

`speech-to-text` 新增 `auto` 偏好和 `autoOrder`。选择在录音之前进行：第一个无需准备即可录音的 Provider 胜出，否则取第一个既不是 unavailable 也不是 failed 的，Client 随录音发送这个确切的 Provider id。识别失败绝不改投其他 Provider；录音期间退出登录时，该次录音失败，而不是换用其他 Provider。一份保存的语言适用于所有 Provider：未列出该语言的 Provider 收到 `auto`。服务自行判断语言，因此云端 Provider 只声明 `auto`，菜单提示云端识别会自动判断语言。

有凭据的用户默认使用云端识别，不弹上传告知；处理方式由用户协议和隐私协议说明，界面在悬停提示、转写状态和 Bundle 详情中标明识别位置，详情还说明费用并链接语音识别指南。这也包括此前使用本地默认值且有凭据的用户：产品为他们选择了云端识别，这修订了语音输入决策中“之后的云端 Provider 不得在用户未选择时改变录音处理位置”的要求。只要插件已启用，麦克风就一直显示。登录使用新的可选 Client 服务 `accountSignIn`，语音 UI 复用账号的登录弹窗和浏览器流程。

## 考虑过的方案

产品否决了首次上传告知，因为用户协议已经覆盖。本地失败后回退到云端识别会破坏现有的无回退保证。早先的 `harness.deepseek.com` 接口被否决，因为它只接受账号登录，并且需要账号服务向第二个 origin 发放 token。在提供云端识别前探测每种凭据的 endpoint 被否决：配置自定义 endpoint 的用户自行负责。在 `ctx.deepseekAuth` 中检查是否为官方 origin 被否决，因为自定义网关可能支持 Search 却不支持语音识别。重试请求被否决，因为服务没有幂等键且按时长计费。在语音 UI 中直接调用 `account.startSignIn` 会重复登录弹窗、标签页所有权和失败状态。

## 影响

发布的 Bundle 启用云端这一行，[升级指南](../../../../docs/upgrade-guide/v0.2.3-alpha.2/voice-input-cloud-default/guide.zh.md)说明如何继续使用本地识别。在对话之外，Search 和 Fetch 接口先用 API Key，而语音识别先用账号登录。HTTP 401 会作废被拒绝的账号登录凭据，账号随之退出登录；服务拒绝账号登录凭据时，会在读完整段录音之前断开连接，因此这次拒绝以 `service-unavailable` 呈现给用户，登录凭据由下一个收到 401 的请求作废。验证覆盖自动路由与语言规则、通过真实 `DeepSeekAuth` 的两种凭据及其顺序、状态码分类，以及在真实组合中通过浏览器登录并对本机服务听写。
