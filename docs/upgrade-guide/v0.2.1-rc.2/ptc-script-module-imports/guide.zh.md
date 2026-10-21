---
kind: upgrade-guide
description: "PTC Script 导入处理器现在会接收显式声明为 ESM 的依赖中的导入。"
---

# PTC Script 处理器接收 ESM 依赖中的导入

[English](guide.md) | 中文

## 变更

向 `runNodeMain()` 或 `runPersistentMain()` 传入 `ProgramImportHandler` 的自定义 runner，现在会接收 `.mjs` 文件以及 `type: module` 包中 `.js` 文件的静态与动态导入。此前，默认和重定向导入将整个依赖图交给 Node。这些 ESM 模块现在在 Script context 内执行，使用求值器拥有的缓存。请求中的文件名指向实际发起导入的模块。其他格式保留原生加载；省略 handler 时，所有导入都保留原生加载。

## 迁移

1. 更新自定义 runner 的 handler，允许 `request.referrer` 为依赖文件名，并对需要普通解析的导入返回 `{ type: 'default' }`。静态导入只绑定一次；改变 handler 结果不会替换既有绑定。
2. 检查依赖原生模块单例或 runner 全局对象的 ESM 依赖。这些依赖现在共享 Script 全局变量，与 runner 原生 ESM 实例相互独立。
3. 运行导入受影响包的 Script，并调用包含 `import()` 的导出函数。确认静态依赖与稍后的动态导入都收到预期的 handler 决策。支持的格式见[运行时导入处理](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md#runner-import-handling)。
