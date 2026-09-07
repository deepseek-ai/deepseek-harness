# Agent Note: 自托管 Linux 上隔离的 Node 兼容性作业

Status: implemented

[English](2026-09-06-node-compatibility-selfhosted.md) | 中文

## 问题

即使仓库已经选择现有的自托管 Linux 池，Node 22.19、24.9 和 26 兼容性作业仍消耗托管 Linux 分钟数。将版本安装器移到持久化共享机器上可能造成工具目录冲突，并让生成的缓存文件积累在运行器清理范围之外。

## 决策

[CI](../../../../.github/workflows/ci.yml) 将 Linux 故障切换变量应用于这三个作业，要求作者不是 Dependabot，且非 fork 的头部仓库与当前仓库相同。标准托管回退仍然可用。这些条件约束本作业，而非所有可进入该池的工作流。仓库身份和 fork 状态均显式保留，以便在仓库设置改变时保持本作业的信任限制；现有兄弟选择器不属于本次迁移范围。

临时工具缓存以重复下载 Node 为代价，换取并发运行器与 Node 版本之间的隔离。仅用于 setup-node 的 [ESM 预加载模块](../../../../scripts/ci-compatible-toolcache.mjs) 在 action 进程内指定缓存：Actions 运行器在读取步骤配置后会覆盖保留的环境变量。实际执行的路径检查拒绝运行器临时目录之外的安装；兼容性进程不继承预加载设置。pnpm 保留现有的私有安装目录和持久化内容寻址 store。编译缓存与 node-gyp 头文件在首次调用 pnpm 前就使用运行器临时目录。不引入全局 Node 符号链接或系统软件包变更。托管作业保留其工具与软件包缓存；自托管作业不恢复或上传托管软件包缓存。运行器负责作业之间的临时目录清理，共享镜像提供原生 npm 软件包所需的编译器和 Python 前置依赖。

[故障切换手册](2026-07-26-ci-failover-runbook.zh.md) 仍拥有仓库信任与池切换规则。[串行参考决策](2026-07-21-serial-cross-platform-ci-reference.zh.md) 仍拥有 master 调度规则。除兼容性作业的运行器选择外，这两个决策都未被取代；两者均保持活跃。

## 曾考虑的替代方案

**让所有兼容性作业保持托管。** 这避免额外的共享主机负载，但继续为不需要不同操作系统或架构的 Linux 运行时检查付费。

**使用共享 Node 安装或全局版本管理器链接。** 这些作业必须并发运行不同的 Node 版本。可变的共享链接会使选中的版本取决于另一作业的时序。

**在同一改动中迁移 Python SDK 作业。** 其 setup-python 安装和通过全局 pip 安装 uv 需要单独的隔离证据。这个短暂的托管作业不是 Node 优化的必需部分。

## 后果

每个可信 PR（Pull Request）会为池增加三个作业；每个作业保留门禁并发度一，包括需要构建的 Node 22 条目。9 月 6 日的清单报告了 31 个 Linux 注册实例，而不是 31 台独立机器。共享虚拟机的资源争用和下载延迟仍是上线风险；变量保留托管恢复路径。测试清单、检查名称和 master 调度保持不变。

## 验证

聚焦的[工作流回归测试](../../../../scripts/ci-compatible-selfhosted.spec.ts) 执行真实的路由表达式和环境设置。移除 fork 条件的负对照使托管回退断言失败。它检查维护者重跑 Dependabot PR、仓库不匹配、fork 标志、禁用变量以及运行器范围内的缓存路径。

实施基线上的[成功热备运行 33984559660](https://github.com/deepseek-harness/deepseek-harness/actions/runs/33984559660) 提供 Linux Node 24.19.0 和 Windows Node 24.20.0 基线证据。Linux 作业 101359402557 使用数据卷上运行器专属的临时目录和工具目录。[只读能力探测 34012679056](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34012679056/job/101431064925) 报告 Linux x64、192 个在线逻辑 CPU、GCC/G++ 13.3、Make 4.3 和 Python 3.12.3。Python 3.10 缺失，进一步说明 SDK 需要单独配置。`282519d2` 上的 [PR 运行 34013779750](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34013779750) 验证了自托管 Linux 上的 Node 22.19.0、24.9.0 和 26.8.1，包括设置、可执行文件路径检查、兼容性测试和 post actions。可执行文件位于各运行器的 `_temp/node-compat-toolcache/node/<version>/x64/bin` 下；完成的作业分别耗时 228s、94s 和 101s。这些观测证明版本与路径兼容性，而非独占主机的容量保证。
