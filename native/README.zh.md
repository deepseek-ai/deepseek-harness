# native/

[English](README.md) | 中文

与 DeepSeek Harness 一同维护的原生源码和公开包。[`system/` workspace](system/README.zh.md) 负责 Landlock 启动器、POSIX flock 绑定、平台包和[发布流程](system/docs/release.md)。

## Workspace 与发布边界

`system/` 及其包属于仓库根 pnpm workspace，并共用根锁文件。开发和 CI 中的 harness 消费方直接使用当前 workspace 的入口包，因此启动器约定变更与消费方更新可以在同一个改动中落地并一起测试。

主仓库的 `Node Addon System` 工作流为每个受支持架构构建并测试。`Node Addon System Release` 汇集这些原生产物，打包并验证 npm tarball，随后可选择以同一个原生包版本发布。入口包继续将平台包声明为 npm 可选依赖，因此 npm 仍然只会安装与用户操作系统和 CPU 匹配的包。
