# Agent Note: 将源码启动与仓库构建分离

Status: implemented
Archived: 2026-09-04

[English](2026-08-12-separate-source-launch-from-build.md) | 中文

## 问题

TypeScript 源码启动器无需在每次调用前完成整个仓库的构建。Web 界面则需要已构建的前端与 Client plugin 产物。由同一个包脚本同时负责这两项操作，会让重复启动 TUI、无头模式和 Web 时都承担全仓库构建延迟，也会掩盖浏览器产物何时刷新。

经由 tsx 加载的源码模块与经由已构建组合包加载的浏览器模块具有不同的新鲜度表现。将两条命令分离后，需要明确产物生成的责任，并准确说明产物缺失与过期时的失败模式。

## 决策

根目录的 `dsh` 脚本只运行 `node --import tsx/esm apps/cli/src/bin.ts`。`pnpm run build` 仍是生成包与前端产物的独立操作。源码用户在首次进行类生产启动前运行构建，并在前端或 Client plugin 产物需要刷新时再次运行。

Typert Host 产物缺失时，profile 启动会因不含构建指引的模块解析错误而失败。这些 Host 产物存在后，如果前端或 Client plugin 产物缺失，启动会失败，诊断信息会指示用户运行 `pnpm run build`。启动器不会验证产物是否为最新：已有的陈旧前端或 Client plugin 组合包仍会被接受，并可能继续运行旧版浏览器代码，直至下次构建。各包的 Node 半侧至少构建过一次后，`pnpm run dev:web` 只重建声明了 `dsh.client` 的包；它会保持 Client plugin 组合包为最新状态并启用其热重载路径，但不会重建前端 shell。

本决策仅规定构建调度。[tsx ESM 源码启动决策](../architecture/2026-07-29-dsh-source-launch-tsx-esm.zh.md)规定 TypeScript 转换与 workspace 解析，[源码运行决策](2026-08-10-source-run-without-managed-installer.zh.md)规定以仓库脚本作为受支持的检出入口，[个人配置决策](../feature/2026-07-20-dsh-cli-personal-config.zh.md)规定机器级配置层。

## 考虑过的备选方案

**每次源码启动前都执行构建。**这样可提供最强的默认新鲜度保证，但即使相关产物已经是最新状态，每次调用仍要承担全仓库产物生成的开销。

**仅在产物缺失时执行构建。**这样可避免部分启动开销，但无法发现过期产物，还会让构建行为变成由当前文件系统内容决定的隐式策略。

**由 `pnpm dsh` 启动 Web 产物 watcher。**这样可保持 Client plugin 组合包为最新状态，却会让一次性启动器负责另一个长时间运行的进程。显式的 `pnpm run dev:web` 命令已经负责这套开发生命周期。

## 影响

- 重复的源码启动无需等待完整的仓库构建，构建输出也不会与 CLI 输出混在一起。
- 源码用户负责产物新鲜度。产物缺失会阻止启动，但只有前端与 Client plugin 产物缺失的错误会指示用户运行 `pnpm run build`；已有的过期前端与 Client plugin 组合包可能静默提供旧版浏览器代码。
- TUI、Web 与无头模式选择、参数转发、环境继承，以及 tsx ESM 启动方式保持不变。
- 根目录上手指南与 CLI 参考将构建和启动列为独立命令，并说明过期产物行为。

## 验证

`apps/cli/tests/source-launch.compat.spec.ts` 固定根目录包命令的准确内容，并执行生产源码启动方式。`packages/bundle/web-app/tests/web-app.spec.ts` 与 `packages/client/modules/tests/node-half.client.spec.ts` 固定产物缺失诊断。
