# Agent Note：带自动选择的 DeepSeek 云端语音识别

Status: implemented

[English](2026-11-04-deepseek-cloud-speech-recognition.md) | 中文

## 问题

实验性语音输入只在 Host 上识别，首次使用必须下载并准备本地模型。已登录 DeepSeek 的用户应能免去这一步直接听写，未登录用户仍可选择本地识别。[语音输入决策](../architecture/2026-09-16-experimental-voice-input.zh.md)禁止悄悄改变录音的处理位置，也禁止本地失败后回退上传语音。

## 决策

独立的 Provider 包 `speech-to-text-deepseek` 以 `location: 'cloud'` 注册 `deepseek-asr`，把完整录音以裸 PCM 发送到 One-Shot 接口，不使用流式 WebSocket 接口。它与账号模型路由使用相同的鉴权，发送账号服务为该 endpoint 发放的令牌；没有已保存的 DeepSeek 账号时拒绝录音。账号服务向默认 endpoint 的 origin `https://harness.deepseek.com` 发放令牌，但从不发放本机回环签发的授权。

`speech-to-text` 新增 `auto` 偏好和 `autoOrder`。选择在录音之前进行：第一个已注册且不是 `unavailable` 的 Provider 胜出，Client 随录音发送这个确切的 Provider id。识别失败绝不改投其他 Provider；录音期间退出登录时，该次录音失败，而不是换用其他 Provider。一份保存的语言适用于所有 Provider：未列出该语言的 Provider 收到 `auto`，因此菜单列出任一 Provider 支持的全部语言，并在当前 Provider 改为自动识别时给出提示。云端 Provider 按语音配置 RFC 的要求，把语言作为 `preferred_language`、把界面语言作为 `x-client-locale` 发送。

已登录用户默认使用云端识别，不弹上传告知；处理方式由用户协议和隐私协议说明，界面在悬停提示、转写状态和 Bundle 详情中标明识别位置。只要插件已启用，麦克风就一直显示。登录使用新的可选 Client 服务 `accountSignIn`，语音 UI 复用账号的登录弹窗和浏览器流程，而不是重写一套。登录后弹窗关闭，由用户点击开始录音；登录标签页会夺走焦点，而失焦会取消录音，所以录音从不在没有点击的情况下自动开始。

## 考虑过的方案

产品否决了首次上传告知，因为用户协议已经覆盖。本地失败后回退到云端识别会破坏现有的无回退保证。在语音 UI 中直接调用 `account.startSignIn` 会重复登录弹窗、标签页所有权和失败状态。菜单只列当前 Provider 支持的语言被否决：自动选择切换 Provider 时，保存的语言看起来会被重置。

## 影响

发布的 Bundle 启用云端这一行，指向生产接口。服务拒绝其他长度的裸 PCM，所以补零到 32 字节，最多增加 1 毫秒静音。账号令牌被拒绝时账号退出登录。验证覆盖自动路由与语言规则、账号鉴权与令牌被拒、使用固定 `audio_id` 的重试，以及在真实组合中通过浏览器登录并对本机服务听写。
