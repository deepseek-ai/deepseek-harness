---
kind: upgrade-guide
description: "Auto review 跨输入传输与已有历史识别 user-source 任务指令。"
---

# Auto review 识别 user-source 指令

[English](guide.md) | 中文

## 变更

实验性 Auto review 将 `source.kind: 'user'` 的文本识别为任务指令，不再要求浏览器 `rpcId`。这包括 Headless、SDK、ACP、以用户身份提交内容的自定义生产者，以及已有的 user-source 历史。显式指令可在其声明范围内授权 medium 风险动作。Child 自身的创建 prompt 和直接父级消息保留从属角色；继承的创建 prompt 与无法验证的创建 prompt 仍是事实。

## 迁移

1. 检查自定义的 `createUserMessage` 调用。仅对作为用户任务提交的输入使用 user source。为后台或注入内容声明生产者自己的 `MessageSourceMap` 成员。
2. 恢复 Auto 前，检查已有 user-source 指令中可能授权 medium 风险动作的内容。在下一个任务中明确替换已失效的范围。
3. 验证 Auto 筛选历史将注入内容归为 `fact` 或 `constraint`，将接纳的用户文本归为 `user-instruction`。文件、工具结果和 checkpoint 不能授权动作。
