---
kind: upgrade-guide
description: "内置 NumPy 和 pandas 不包含其上游测试套件。"
---

# NumPy 和 pandas 上游测试需要独立环境

[English](guide.md) | 中文

## 变更

Desktop 和 Python SDK 运行时分发包此前包含 NumPy 和 pandas 测试目录。内置分发包现在裁剪这些目录，因此导入其测试模块或运行其完整上游测试套件的脚本需要独立安装环境。数据处理、Office 创作、`numpy.testing`、`pandas.testing` 和 `pandas._testing` 仍然可用。

## 迁移

1. 如果脚本导入 `numpy.*.tests` 或 `pandas.tests`，请在独立 Python 环境中安装原始 NumPy 和 pandas 分发包及其上游测试依赖。请将该环境放在 Harness 托管运行时目录之外，升级会替换托管目录。
2. 使用该环境的解释器运行受影响的脚本或上游测试套件。仅使用库功能或保留的 testing 辅助 API 的脚本无需修改。
3. 确认先前失败的测试模块导入及相关脚本均可在独立解释器中成功运行。随包版本记录在[运行时锁文件](../../../../scripts/primary-runtime/lock.json)中。
