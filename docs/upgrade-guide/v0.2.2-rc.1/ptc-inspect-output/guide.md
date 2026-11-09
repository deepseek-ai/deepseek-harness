---
kind: upgrade-guide
description: "TypeScript PTC programs use Harness.inspect for visible output and start without a console global."
---

# Explicit output in TypeScript PTC programs

English | [中文](guide.zh.md)

## Change

TypeScript `run_code` programs display selected values through `Harness.inspect(...values)`. Function return values and final expressions previously appeared in the result; they are now omitted. Each inspected argument is rendered independently, so strings containing `%s` or `%d` remain literal.

The Node runtime starts without a console global by default. Reading `console` raises `ReferenceError`, and `typeof console` returns `"undefined"`. Its `enableConsole: true` configuration exposes `log`, `info`, `warn`, `error` and `debug` through the same inspection function.

## Migration

1. Update programs that print with console or rely on completion values to explicitly inspect the values they need:

   ```js
   const result = await tools.bash({ command: 'pwd', description: 'Show current directory' })
   Harness.inspect(result)
   ```

2. Replace format strings with separate arguments or template strings. For example, use `Harness.inspect('count:', count)` instead of `console.log('count: %d', count)`.
3. Update CUA bridge callbacks to `text => Harness.inspect(text)`.
4. For integrations that require console methods, set `enableConsole: true` on the `@deepseek-ai/dsh-ptc-runtime-node` provider row. Direct runtime consumers can set `discardCompletion: true` to select the same explicit-output behavior.
5. Run an updated program and verify that inspected values appear once and its final expression adds no output.
