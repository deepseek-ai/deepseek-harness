---
description: "为文档工作流提供渐进加载的 Office 创作与 CLI 操作技能。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-office

[English](README.md) | 中文

## 概述

目录列出 Office 路由及六个创作或操作技能，完整说明按需加载。创作技能使用选定的 Python 库；操作技能提供配置的 Node 与 LibreOffice Kit CLI 路径。SDK 和 Desktop 分别挂载技能提供者和依赖查询。

## 目录

- [使用本包](#use-this-package)
  - [渐进加载](#progressive-loading)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在技能注册表和 `dsh-tool-skill` 旁挂载技能提供者。提供者负责技能说明；操作技能在加载时附加解释器和 CLI 的绝对路径。

```yaml
- name: '@deepseek-ai/dsh-skill-office'

```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `assetRoot` | 载体资源或包内 `assets/` | 包含七个技能目录的绝对路径。 |
| `node` | 宿主 Node.js | 操作技能使用的独立 Node 可执行程序；打包载体显式提供。 |
| `cli` | 已安装 Kit CLI | CLI 入口的绝对路径；`false` 禁用操作执行。 |

无效技能资源会阻止注册。创作说明不解析渲染器路径；操作说明加载时校验现有解释器和 CLI 文件，不准备引擎。Bash 或 PowerShell 负责审批、沙箱、取消和输出管理。资源与执行工具必须位于同一主机。

<a id="progressive-loading"></a>
### 渐进加载

模型依据任务选择技能；宿主不会根据文件扩展名注入完整说明。七个技能均列入目录，可通过 `skill` 按名称加载或由用户显式调用。用户要求的外观修改，包括电子表格单元格填充和文本对齐，即使没有明确要求视觉检查，也需要渲染；用户明确要求跳过渲染时以该要求为准。纯操作任务可以直接进入对应技能。

```mermaid
flowchart TD
    A["Initial catalog: seven Office summaries"]
    A -->|Non-Office task| N["Continue without loading Office instructions"]
    A -->|Office task| B["skill(office): task routing"]

    B -->|Create or edit| C["skill(office-docx / office-pptx / office-xlsx)"]
    C --> D["Author and validate content, structure and data"]
    D -->|No additional operation needed| F["Deliver"]

    B -->|Images, visual inspection, or appearance changes| R["skill(office-render)"]
    D -->|Images, visual inspection, or appearance changes| R
    R --> RC["Shell: render into a private workspace temporary directory"]
    RC -->|Usable preview| V["Inspect requested images"]
    V --> F
    RC -->|Failed or blank preview| L["Report content checks and unfinished visual inspection separately"]
    L --> F

    B -->|Formula recalculation| X["skill(office-recalculate)"]
    D -->|Formula recalculation| X
    X --> XC["Shell: CLI recalculate and verify values"]
    XC --> F

    B -->|PDF export| P["skill(office-export-pdf)"]
    D -->|PDF export| P
    P --> PC["Shell: CLI convert"]
    PC --> F
```

新建文件以及内容、数据或公式修改，不会仅因附带基础格式调整而需要渲染。预览图片保存在工作区内随机命名的私有临时目录中，并在检查后删除；回复以文字说明检查结果，不链接这些图片。PDF 导出校验命令结果和 `%PDF-` 签名，不另外查找 PDF 阅读工具。操作结束后，已加载的说明仍属于会话历史。图中描述各端常规预设，不改变 minimal 或 sdk-minimal 的纯 shell 定义。

普通 Word 文本编辑只检查目标文本片段及其格式，保存后重新打开文档验证修改。检查通过即结束验证；只有遇到具体问题或明确要求时才探查内部包结构和元数据。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

提供者在注册时读取摘要，按需读取正文。注册表优先级、作用域和调用权限适用于全部技能。加载结果包含用于解析相对引用的资源目录。卸载提供者会移除全部候选技能。

提供者不注册工具或激活投影。通用技能加载器记录已加载技能的结果。PTC 程序需输出或返回完整的 `tools.skill(...)` 结果，使说明进入模型上下文。恢复和 fork 使用现有会话历史及工具声明更新机制。解释器和 CLI 路径仅在加载操作技能时解析。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 注册资源并返回原始技能正文。 |

| [`assets/`](assets/) | 路由与六个子技能。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [技能注册表](../skill/README.zh.md) — 发现和优先级。
- [技能工具](../tool-skill/README.zh.md) — 模型目录和加载正文。
- [文件交付](../../deliverables/tool-present/README.zh.md) — 当前源文件路径交付。

-----

<a id="model-experience"></a>
## 模型体验

间接影响：`dsh-tool-skill` 渲染初始 Office 摘要，并返回 `skill(name)` 选择的路由或子技能说明。

#### KV Cache 影响

技能结果追加到历史中且不改变工具声明，操作完成后已加载文本或图片仍保留在历史中。字符估算采用 `ceil(字符数 / 4)`：摘要最多 50 token，路由正文最多 200 token；创作正文比合并后的创作与操作指南至少减少 35%。技能包装、通用目录、shell 声明和 `load_workspace_dependencies` 单独计费；这些估算不等同于服务端 usage。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 提供者不安装创作库。
- LibreOffice 输出可能不同于原生 Office 应用。
- 旧格式、加密和启用宏的文件需要适用的独立工作流。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
