---
kind: upgrade-guide
description: "The Web and Desktop clients run React 19 instead of React 18, so client plugins receive React 19 from the browser module table and compile against React 19 types."
---

# Client plugins run on React 19

English | [中文](guide.zh.md)

## Change

In 0.2.3-alpha.2, the Web and Desktop shells put React 18.3 into the browser module table, and DSH packages compiled against `@types/react` 18.3. They now provide React 19.3 and compile against `@types/react` 19.3. DSH no longer supports React 18.

A client plugin that imports `react`, `react/jsx-runtime`, `react-dom`, or `react-dom/client` from the [shared module table](../../../../packages/client/web/README.md#the-shared-module-table) runs on React 19. Elements created by a bundled React 18 copy do not render under React 19. Code that uses an API React 19 removes fails at runtime; the [React 19 upgrade guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide) lists them. Those most likely in plugins are `ReactDOM.render`, `findDOMNode`, `unmountComponentAtNode`, `react-dom/test-utils`, string refs, legacy context, and `defaultProps` or `propTypes` on function components. A ref is an ordinary prop, so read `element.props.ref`; reading `element.ref` logs a warning.

TypeScript code sees the React 19 types: the global `JSX` namespace is gone, `useRef` requires an argument, a callback ref must not return a value other than a cleanup function, and `FC` returns `ReactNode | Promise<ReactNode>`. [`SlotComponent`](../../../../packages/client/ui-slots/src/client/index.ts) accepts that return type, so a component annotated with `FC` registers through `ctx.slots.register` without a cast. `@deepseek-ai/dsh-client-test-runtime` now requires `react` and `react-dom` `^19.3.1` as peers, where it required `^18.2.0`.

## Migration

1. In each client plugin manifest, set `react` and `react-dom` to `^19.3.1` and `@types/react` and `@types/react-dom` to `~19.3`.
2. Keep `react`, `react/jsx-runtime`, `react-dom`, and `react-dom/client` external in the browser build, as the deployment's Client build tooling does; remove any bundled React copy.
3. Replace the removed APIs: render through `createRoot`, import `act` from `react`, read refs from props, and give function-component props default parameter values. Run `npx types-react-codemod@latest preset-19 ./src` to update the types, then replace remaining `JSX.Element` with `React.JSX.Element` and `useRef<T>()` with `useRef<T>(undefined)`.
4. Run `tsc` against `@types/react` 19.3 and confirm that it reports no errors. Load the plugin in the Web UI and confirm that the browser console shows no React errors or warnings while you use it.
