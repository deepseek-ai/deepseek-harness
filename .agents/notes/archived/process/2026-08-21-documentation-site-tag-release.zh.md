# Agent Note: 文档站从发布 tag 发布

Status: implemented
Archived: 2026-09-04

[English](2026-08-21-documentation-site-tag-release.md) | 中文

## Problem

本项目对外的每一个面都只在发布 tag 上前进。npm 序列从 `dsh-v*` tag 经人工审阅的手动 dispatch 发布，Python wheel 从 `python-v*` tag 发布，背后有发布仓库校验和两个受保护环境，公开源码仓库也只推进到每个发布 commit。文档网站却在每次触及 `docs/`、`website/`、投影器或锁文件的 master 推送上部署，既没有审阅人也没有版本校验。尽管仓库是私有的，该站点无需认证即可访问，因此一次合并会在几分钟内把文档发布到公网：其中包含描述尚无任何已发布产物承载的工作的页面，以及从领先于读者所能获取的一切的源码树生成的参考资料。

## Decision

`docs-pages.yml` 只声明 `workflow_dispatch`，并从 `dsh-v*` tag 发布，这正是 `release-publish.yml` 为 npm 采用的结构：发布是从发布 tag 出发的显式动作，绝不作为拉取请求检查出现。

build 作业在构建任何东西之前先以 `RELEASE_PUBLISH=true` 运行 `release:verify --family dsh`。这就是 npm 发布所用的门禁，因此站点和 npm 序列共用同一个「已发布版本」的定义，而不是各自携带一份：运行必须来自 `refs/tags/` ref，tag 必须带有该家族前缀，且 tag 必须命名工作树确实携带的版本。checkout 取完整历史，因为发布脚本要读 tag。

`github-pages` 环境携带 `dsh-v*` 部署 tag 策略和必需审阅人，与 `npm-publish` 一致。两层应对的是不同的失效：脚本门禁拒绝从错误 ref 发起的 dispatch，而当日后某次工作流编辑不再校验时，环境策略仍会拒绝该次部署。

`DOCS_REPOSITORY_REF` 保持 `master`，因此投影出的源码链接继续指向公开仓库的默认分支，而不是被 dispatch 的 tag。该仓库只推进到每个发布 commit，所以它的 master 从不携带未发布的工作，被发布的 tag 在暴露控制上没有任何增益。它还只保留最近的若干 tag，因此跟随被 dispatch 的 tag 会让从较旧 tag 部署的站点上每一条投影源码链接都无法解析。

构建覆盖不依赖本工作流。`check:ci:static` 在每个拉取请求上通过 `docs:build:mpa` 构建生产站点，`ci-master.yml` 在 master 上再构建一次；[投影 Agent Note](2026-07-13-documentation-site-projection.zh.md) 正是出于这个理由否决了把该构建挪进部署工作流，而 tag 门禁化的发布让这条分离真正承重。

`ci-workflow.spec.ts` 在 npm 与 Python 发布断言旁钉住这个形状：`on` 只携带 `workflow_dispatch`，build 作业以 `RELEASE_PUBLISH` 运行 tag 校验，checkout 取完整历史，`DOCS_REPOSITORY_REF` 读作 `master`，deploy 作业保留 `github-pages` 环境。

## Alternatives considered

**保留 master 推送，只给环境加必需审阅人。** 这只需改一处工作流，且不必协调仓库设置，就能把人放进回路。它败在审阅人被问的问题上：每次文档合并都弹出的审批提示，是审阅人会学会不读就放行的提示，而且没有任何东西把被批准的内容与任何人可安装的版本联系起来。审阅人回答的是「这页看着能发吗」，而问题是「这是已发布的吗」。

**让 `DOCS_REPOSITORY_REF` 跟随被 dispatch 的 tag。** 让来自某个 tag 快照的页面链接到该快照的源码，比链接到一个分支更精确。但在这里代价大于收益：公开仓库只保留最近的若干 tag，因此从较旧 tag 部署（正是一次糟糕发布的自然应对）会让全部投影源码链接一次性失效，而它的 master 本就不可能暴露未发布的工作。

**发布一个独立的公开站点，内部站点继续跟随 master。** 内部站点跟随 master 能为贡献者保留当天预览，同时公开站点跟随发布。GitHub 每个仓库只提供一个 Pages 站点，因此这需要第二个仓库，而公开组织目前不运行签入的 CI 工作流。这是押后而非否决：本决策没有堵死它，因为第二个目的地消费的正是本工作流已经构建出的 `website/.dist`。

**把 Pages 站点改为私有。** 把 Pages 可见性切到组织成员只需一处仓库设置且即时生效，本组织的套餐也支持。它回答的是另一个问题：它把站点从本应看到它的读者面前藏起来，同时并未把文档发布与发布状态挂钩。tag 门禁化的发布让站点内容等同于公开仓库已经承载的内容，因此限制可见性没有任何增益。

## Consequences

文档、npm 包、Python wheel 和公开源码仓库现在在每个发布 tag 上一同前进，没有哪次合并能独自抵达公开读者。发布的代价是每次发布一次 dispatch，而两次发布之间的文档修复要等到下一个 tag 才会公开：这与另外三个面承担的延迟相同。从分支发起的 dispatch，或从一个工作树并不携带其版本的 tag 发起的 dispatch，会在构建运行之前于校验步骤失败。

本工作流不再于每次合并证明 Pages 风味的构建可用，因为它不再在合并上运行；`check:ci:static` 和 `ci-master.yml` 覆盖生产构建，而本工作流在其之上追加的 base 路径配置只在发布时被执行到。

已经从 master 推送部署出去的站点会继续提供那份内容，直到第一次 tag dispatch 替换它。对一个既有 tag 发起 dispatch 会运行该 tag 上的工作流文件，因此对早于本次改动的 tag 发起 dispatch 会走此前的工作流定义。
