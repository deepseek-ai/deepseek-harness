# Agent Note: 等待 Windows Python 控制台运行时

Status: implemented

[English](2026-09-06-windows-python-console-spawn-wait.md) | 中文

## 问题

Python 安装的 `dsh.exe` 控制台命令会在初始化 profile 前间歇性地以 Windows 访问冲突 `0xc0000005` 退出。其冒烟断言遗漏进程状态，只报告空标准流。[原生 faulthandler 探测](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34030851888) 将故障定位在运行时控制台入口调用的 Python 3.10 `os._execvpe`，而非打包的 Node 可执行文件。直接启动可执行文件的对照通过。

## 决策

[Python 控制台入口](../../../../python/sdk-runtime/src/deepseek_harness_runtime/__init__.py) 在 Windows 上使用 `subprocess.run`，继承标准流与环境，等待运行时结束，再以运行时状态退出。POSIX 保留 `os.execvpe` 进程替换。Windows CRT exec 并非 POSIX 进程替换；显式启动并等待的路径避开观测到的原生 exec 操作。

[安装后 wheel 冒烟测试](../../../../scripts/smoke-python-runtime.py) 在 profile 安装失败时，同时报告十进制、无符号 32 位十六进制状态与捕获的标准流。这保留普通命令失败和原生进程异常的区别。

## 已考虑的替代方案

**禁用 Node 编译缓存。** 未采用：早期探测中缓存环境变化与结果相关，但冷缓存对照也能通过，且 Python faulthandler 将实际故障定位在原生 exec 调用。缓存配置保持不变。

**重试或绕过已安装的控制台命令。** 拒绝，因为二者都会掩盖已发布命令的失败，而不是修复进程启动。keyless 安装后 wheel 断言仍为必需检查。

## 后果

Windows 保留 Python 父进程直到运行时退出，不再依赖 CRT overlay 行为。标准同步子进程实现负责等待和中断清理。不添加自定义进程树管理器或全局主机设置。

[运行时解析测试](../../../../python/sdk/tests/test_runtime_resolution.py) 保留 POSIX 转发验证，并覆盖 Windows 参数／环境转发、状态 0/37/513、真实子进程完成、Unicode 标准流和带空格的参数。宽退出状态由原生 Windows 验证，因为 POSIX 会将进程状态截断为八位。[原生固定次数对照](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34031142773) 中，启用编译缓存的四次修复后启动全部通过；该批次四次未修复对照也全部通过，因此它不是同批次复现。完整安装后 wheel CI 必须独立于本地分支级测试，验证最终产物。
