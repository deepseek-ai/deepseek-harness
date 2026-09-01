---
description: "DeepSeek Harness 主目录与用户数据路径的共享解析，供需要统一根目录、波浪号展开与稳定监听路径的包使用。"
kind: "package-library"
---

# @deepseek-ai/dsh-home-paths

[English](README.md) | 中文

## 概述

`dsh-home-paths` 解析所有用户数据所在的统一 DeepSeek Harness 主目录，并把子路径拼接上去，让每个产品包都就文件存放位置达成一致。优先级是显式的：显式配置的路径优先，然后是 `$DSH_HOME`，最后是 `~/.dsh`；空或仅含空白的 `$DSH_HOME` 视为未设置。该包还针对操作系统主目录展开 `~`、`~/...` 与 `~\...` 前缀，并规范化监听目标，让原生文件系统 watcher 即使在最终路径段尚不存在时也能获得一种稳定的路径写法。它是一个零依赖库，由产品包直接导入；`cordis.yml` 无法加载它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当包必须与 harness 的其他部分就用户数据存放位置达成一致时使用这些辅助函数：先解析一次主目录，再从中派生所有子路径。

### 解析主目录

```ts
import { resolveDshHome, dshHomePath } from '@deepseek-ai/dsh-home-paths'

const home = resolveDshHome()                // configured path, else $DSH_HOME, else ~/.dsh
const settings = dshHomePath('settings')     // join one child onto the resolved home
```

显式配置的路径优先级最高，然后是 `$DSH_HOME`，最后是默认的 `~/.dsh`。空或仅含空白的 `$DSH_HOME` 视为未设置，因此空白的覆盖值绝不会把主目录解析到当前工作目录。

### 展示主目录

面向用户的路径请以符号形式渲染根目录，而不是机器路径：默认主目录显示为 `~/.dsh`，任何已配置的主目录显示为 `$DSH_HOME`。展示形式绝不会泄露机器的绝对路径。

### 展开用户路径

`expandHomePath` 针对操作系统主目录展开开头的 `~`、`~/` 或 `~\`，其余内容原样保留——非波浪号路径以及 `~alice/...` 等指定用户的形式不做任何改动。

### 规范化监听路径

`canonicalizeWatchPath` 为原生文件系统 watcher 提供目标路径的一种规范化写法：先通过 `realpath` 解析层级最深的现有祖先，再拼回缺失的后缀，因此文件或目录在创建之前就可以被监听。这可以防止 Windows 把普通文件祖先当作普通缺失处理，也防止 8.3 短名别名与原生 watcher 后端发出的长路径混用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包建立在一个原则上：harness 的所有用户数据都位于同一个根目录下，其他每个辅助函数都由该决策派生。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 主目录解析、路径拼接、展示、波浪号展开与监听路径规范化 |
| — | 不发布运行时不变式伴生入口；解析规则由单元测试覆盖。 |

### 解析规则

`resolveDshHome` 先读显式覆盖值，然后读 `$DSH_HOME`，最后回退到操作系统主目录拼接 `.dsh`。选中的值经过波浪号展开并规范化为绝对路径；`dshHomePath` 用 Node 的平台路径规则拼接子路径段。`dshHomeDisplay` 把解析出的路径与默认根目录比较并返回符号标签，因此已配置的主目录绝不泄露其绝对路径。

### 规范化机制

`canonicalizeWatchPath` 从目标向上逐级查找，直到找到现有祖先，用 `realpath` 解析它、证明它是可枚举目录，再拼回缺失的后缀。除路径不存在以外的错误都会传播；缺失后缀的祖先若不是目录则被拒绝。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你需要启动器或依赖统一主目录根的消费方时，阅读以下页面。

- [boot 包](../../boot/app-boot/README.zh.md)——在任何插件挂载之前解析主目录的启动器。
- [shell 环境](../../shell/shell-env/README.zh.md)——`DSH_HOME` 如何到达模型 shell 调用。
- [匿名用户 id](../../identity/anonymous-user-id/README.zh.md)——位于解析后主目录下的存储身份文件。

-----

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明这些辅助函数何时不是合适的工具。它们是当前包约束，不是任务积压。

- **展开范围刻意保持狭窄**——只有单独的 `~`、`~/...` 和 `~\...` 使用当前操作系统主目录；`~alice/...` 等指定用户的形式、环境变量与 shell 表达式保持不变。
- **规范化只读不改**——`canonicalizeWatchPath` 执行 `realpath` 探测并传播除路径不存在以外的错误；调用方仍负责目录创建、权限，以及对结果路径应用信任策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
