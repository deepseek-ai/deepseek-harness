---
description: "为 Web 和 SDK agent 提供共用的文件链接与结果交付说明。"
kind: "package-reference"
---

# @deepseek-ai/dsh-deliverable-file-references

[English](README.md) | 中文

## 概述

Agent 在 Web 和 SDK 会话中接收相同的文件链接与结果交付说明。宿主能够提供链接或已交付文件时，可使用这段指导。它增加一个固定的系统提示词段落；文件访问与渲染仍由宿主负责。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web 和 `sdk` bundle 独立于 `present` 工具挂载本插件。自定义组合仅需提供 `systemPrompt`：

```yaml
- id: deliverable-file-references
  name: '@deepseek-ai/dsh-deliverable-file-references'
```

本包没有配置字段。执行文件交付时，需单独挂载 [`dsh-tool-present`](../tool-present/README.zh.md)。禁用本行即可省略这段指导。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[插件入口](src/index.ts)按共享的 `DELIVERABLE_FILE_REFERENCES` 顺序注册 `ui:deliverable-file-references`。卸载时 Cordis 移除该段落。本插件不读取文件，也不启动 GUI 或传输服务。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [系统提示词](../../core/system-prompt/README.zh.md)——段落组装与顺序。
- [Present 工具](../tool-present/README.zh.md)——可执行的文件交付声明。
- [Web 交付](../../client/ui-deliverables/README.zh.md)——文件卡片与文件打开。

<a id="model-experience"></a>
## 模型体验

### 文件引用指导

#### 模型看到的内容

每次组装均包含同一个静态段落：

##### 共用指导

```markdown
Prefer showing the primary results within your final response alongside a brief explanation. Use ![Description](<path/to/image.png>) when an image supports an explanation or comparison. Use [Description](<path/to/image.png>) when referring to an image or listing files. Enclose Markdown file destinations in angle brackets, especially paths containing spaces. Do not call present just to list edited source files, or run commands to check whether a diff view will appear. Use present to publish complete deliverables, including images, Office documents, spreadsheets, and slide decks, when separate access helps the user. Hosts that support file cards can show the presented file with preview and open actions. Avoid repeating results already shown inline unless the separate card adds useful access. Outside commands, configuration expressions, and code blocks, link every mention of an existing file, including repeats and tables, to its full path relative to the working directory or absolute; append #L24 or #L24-L30 to the target for known lines. Use the filename or a clear alias as the label, adding only enough parent directories to distinguish files; keep full paths out of labels. Default to the name alone; when precise locations matter, append :24 or :24–30, with no # or L in the line suffix.
```

#### Token 影响

挂载期间增加一个固定段落，不增加工具 schema 或额外模型请求。

#### KV Cache 影响

该段落跨轮次保持 first-party 顺序 9000。挂载、移除或修改它会改变组装后的提示词前缀；它不增加逐轮变化的值。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 指导要求宿主支持文件链接或交付；本插件不实现渲染、文件访问或 `present` 工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
