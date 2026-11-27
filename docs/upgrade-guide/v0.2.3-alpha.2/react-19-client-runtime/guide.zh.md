---
kind: upgrade-guide
description: "Web 与 Desktop 客户端由 React 18 改为运行 React 19，客户端插件从浏览器模块表拿到 React 19，并按 React 19 的类型编译。"
---

# 客户端插件运行在 React 19 上

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，Web 与 Desktop 外壳向浏览器模块表提供 React 18.3，DSH 各包按 `@types/react` 18.3 编译。现在它们提供 React 19.3，并按 `@types/react` 19.3 编译。DSH 不再支持 React 18。

从[共享模块表](../../../../packages/client/web/README.zh.md#the-shared-module-table)导入 `react`、`react/jsx-runtime`、`react-dom` 或 `react-dom/client` 的客户端插件运行在 React 19 上。插件自带的 React 18 副本创建的元素无法在 React 19 下渲染。使用 React 19 已移除 API 的代码会在运行时失败，完整列表见 [React 19 升级指南](https://react.dev/blog/2024/04/25/react-19-upgrade-guide)。插件中最常见的是 `ReactDOM.render`、`findDOMNode`、`unmountComponentAtNode`、`react-dom/test-utils`、字符串 ref、旧版 context，以及函数组件上的 `defaultProps` 或 `propTypes`。ref 是普通 prop，应读取 `element.props.ref`；读取 `element.ref` 会输出警告。

TypeScript 代码看到的是 React 19 的类型：全局 `JSX` 命名空间已移除，`useRef` 必须传参，回调 ref 只能返回清理函数，不能返回其他值，`FC` 的返回类型为 `ReactNode | Promise<ReactNode>`。[`SlotComponent`](../../../../packages/client/ui-slots/src/client/index.ts) 接受这一返回类型，因此标注为 `FC` 的组件无需类型断言即可通过 `ctx.slots.register` 注册。`@deepseek-ai/dsh-client-test-runtime` 的 peer 依赖改为要求 `react` 与 `react-dom` `^19.3.1`，原先为 `^18.2.0`。

## 迁移

1. 在每个客户端插件的 manifest 中，把 `react` 与 `react-dom` 设为 `^19.3.1`，把 `@types/react` 与 `@types/react-dom` 设为 `~19.3`。
2. 浏览器构建中保持 `react`、`react/jsx-runtime`、`react-dom` 与 `react-dom/client` 为 external，部署的 Client 构建工具默认如此；删除插件自带的 React 副本。
3. 替换已移除的 API：通过 `createRoot` 渲染，从 `react` 导入 `act`，从 props 读取 ref，函数组件的 props 默认值改用参数默认值。运行 `npx types-react-codemod@latest preset-19 ./src` 更新类型，再把剩余的 `JSX.Element` 改为 `React.JSX.Element`，把 `useRef<T>()` 改为 `useRef<T>(undefined)`。
4. 用 `@types/react` 19.3 运行 `tsc`，确认没有错误。在 Web 界面中加载插件并操作，确认浏览器控制台没有 React 错误或警告。
