# Agent Note: Python 公开发布工作流

Status: implemented

[English](2026-08-11-python-publication-workflow.md) | 中文

## 问题

Python SDK 由一个平台无关的客户端 wheel 包和五个原生运行时 wheel 包组成，它们必须使用同一版本，并作为一组可安装。public PyPI 上传会立即公开包元数据和文件，无法替换已上传的同名文件；如果精确版本的运行时依赖尚未到达，还会产生暂时不可用的 SDK。私有仓库需要在不向外发布任何产物的情况下，执行完整的原生构建与验证流程。

## 决策

GitHub 的 `Release (Python)` 工作流为设置 `publish=false` 的手动运行提供无凭据验证。该运行会为全部五个目标调用原生 wheel 包构建器，在 Python 3.10 和 3.14 上安装 Linux 发行集合，下载所得六份产物，验证其精确文件名和包元数据，执行 PyPI 默认单文件大小限制，记录 SHA-256 哈希，并保留一份汇总候选发行版。这些作业只有仓库读取权限，没有注册表凭据或 OIDC 权限，dry-run 运行无法进入任何发布作业。

设置 `publish=true` 时，运行必须在私有自动化仓库使用 `python-v<repository-version>` 标签，将该仓库的 `github.repository` 与其仓库级 `PYPI_PUBLISHER_REPOSITORY` 变量匹配，找到 `PUBLIC_PYPI_RELEASE_ENABLED=true`，并分别获得 GitHub `pypi-runtime` 和 `pypi` 环境对运行时与 SDK 发布的批准。只读公开镜像提供包元数据 URL，但不运行发布 Actions。只有两个发布作业获得 `id-token: write`；PyPI Trusted Publishing 会把私有仓库身份换成短期项目凭据，因此仓库不保存 PyPI token。

发布过程使用同一次工作流运行中生成并检查过的汇总产物。每个发布作业都会在选择上传文件前验证保留的 `SHA256SUMS`。一个运行时作业先上传全部五个平台 wheel 包，再由依赖它的作业上传 SDK wheel 包，因为 PyPI 上传不是原子操作，而 SDK 会把运行时分发包固定到完全相同的版本。两个作业都不会检出源码，也不会重新构建 wheel 包。将它们拆开后，GitHub 的失败作业重试可以在 SDK 上传失败时继续执行，而不会尝试替换不可变的运行时文件。

两个发布 action 都会禁用公开 attestation。action 仍使用 Trusted Publishing 进行身份认证，同时不上传会披露私有发布仓库而非公开源码镜像的 provenance。

仓库版本可以是稳定版，也可以使用受支持的预发布写法。标签保留仓库写法，wheel 包文件名、元数据、依赖版本固定和产物查找则使用规范化的 PEP 440 写法。

运行时包的 `platforms.json` 是原生 wheel 包标签和可执行文件名的事实来源。仓库发行构建器与隔离 Hatch 构建钩子会分别校验并加载该文件。GitHub Actions 与 GitLab CI 对运行时可执行文件及其必需的 spawn helper 调用同一个仓库自有的 macOS 部署目标检查，因此 wheel 包中的每个 Mach-O 文件都必须符合声明的平台标签。

两个 Python 构建系统依赖都固定使用 Hatchling 1.30.1。下一个可用的 Hatchling 版本会生成 Core Metadata 2.5，而固定使用的 Twine 6.2.0 校验器会拒绝该版本；精确固定构建器后，本地、GitHub 与 GitLab 的输出会保持一致，直到校验工具链支持该元数据版本。

## 考虑过的替代方案

**使用 TestPyPI 演练。** TestPyPI 是公开索引，上传会在仓库开放前暴露包名、元数据和 wheel 包内容。无凭据的汇总产物与既有私有 GitLab 包注册表可以覆盖验证和上传协议演练，而不会造成这种披露。

**使用长期 PyPI API token。** 保存的 token 会让无关工作流步骤接触可复用的密钥，并需要人工轮换。Trusted Publishing 把凭据限制到已登记的仓库、工作流和环境，并且只为每个受保护的发布作业生成凭据。

**在发布作业中重新构建。** 第二次构建可能与通过原生冒烟测试的候选产物不同。发布过程下载并使用同一批已保留文件，且不检出任何源码。

**先上传 SDK，再上传运行时载体。** 如果后续上传失败，SDK 会先公开，而其精确依赖仍不可用。运行时优先的顺序使部分失败不会产生指向缺失文件的可安装客户端。

**从公开镜像发布。** 公开镜像是只读源码投影，不运行发布 Actions。将 PyPI Publisher 绑定到该镜像后，没有工作负载能够提供已登记的 OIDC 身份。

**发布公开 attestation。** action 默认行为会让 Trusted Publisher 仓库身份可公开验证。该 provenance 标识私有自动化仓库而非包的公开源码镜像，因此发布作业将其禁用。

## 后果

完整候选发行版与公开发布都从私有自动化仓库运行。选择 `publish=true` 后，只有发布仓库变量、发布开关和标签都能标识一次有意的公开发布，工作流才会进入受保护的发布作业，否则会提前失败。镜像代码不会复制这些私有仓库设置，因此只读公开镜像无法满足授权检查。

私有自动化仓库 owner 和仓库名、工作流文件名以及每个作业的环境（运行时使用 `pypi-runtime`，SDK 使用 `pypi`）都是 Trusted Publisher 身份的一部分。源码仓库转移、工作流改名或环境改名后，必须更新受影响的 PyPI Publisher；仓库身份变化时还必须更新发布仓库变量。只读公开镜像发生变化时，需要修改的是包元数据 URL，而不是发布身份。

两个分发项目之间的 PyPI 发布仍然不是原子操作。运行时优先的顺序会缩小可见的失败状态；独立的发布作业和校验和验证则让失败的 SDK 上传能够从经过检查的精确文件继续执行，并且绝不替换已上传的同名文件。

禁用公开 attestation 会放弃上传身份的公开密码学 provenance。Trusted Publishing 仍会认证每次上传，而保留的汇总产物会在私有发布工作流内部保存经过检查的 wheel 包哈希。

升级 Hatchling 时，必须先使用发布流水线固定的 Twine 版本验证其生成的 Core Metadata 版本，再同时修改两个包的构建依赖。
