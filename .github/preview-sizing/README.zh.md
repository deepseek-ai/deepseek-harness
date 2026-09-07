# PR 预览运行器规格

[English](README.md) | 中文

## 摘要

[预览工作流](../workflows/build-preview-cloudflare.yml) 在标准 GitHub 托管 `ubuntu-24.04` 上构建 PR（Pull Request）预览。运行器规格选择比较完整作业成本，而非仅比较每分钟价格或核心数。

## 目录

- [比较要求](#comparison-requirements)
- [发布语义](#publication-semantics)
- [开发备注](#dev-note)

<a id="comparison-requirements"></a>

## 比较要求

规格实验保持检出 SHA、锁文件、Node 与 pnpm 版本、工作区构建以及预览/VFS 打包命令一致。每个运行器启动时均无构建产物。冷安装不恢复依赖缓存，但 pnpm 引导安装文件可能已存在；热安装恢复同一个精确缓存，不使用前缀回退。记录实际运行器镜像、CPU、内存、磁盘、缓存结果、各阶段耗时、退出状态与内存峰值。GNU time 最大 RSS 表示进程最大值，而非构建进程树同时占用的内存总量。

估算总计算费用时，将每个已完成作业的运行分钟数向上取整，乘以对应运行器费率后求和。纳入设置、缓存恢复、清理、失败及测量数据上传的开销。单独报告缓存预热作业。排队延迟属于延迟观测，不属于作业执行时间。这些估算不是账单总额；标准运行器的套餐内分钟数及存储另行计算。

仅构建的基准测试不部署、不访问 Cloudflare 凭据，也不发布 PR 评论。其成本不能证明完整预览发布成本。在将部署延迟与受保护镜像交付视为已验证之前，须通过实际预览工作流确认所选运行器。

<a id="publication-semantics"></a>

## 发布语义

运行器选择不改变 PR 事件、按 PR 取消、不可变安装、只恢复的依赖缓存、完整工作区构建、预览打包、sourcemap 删除，以及复制到部署根目录的预览页面。Cloudflare 仅将构建站点上传至 PR 分支别名。受保护镜像检查要求 HTTP 200、无传输内容编码及 gzip 魔数字节；URL 评论保持幂等。Dependabot 与其他 PR 作者仍使用 GitHub 托管机器。

<a id="dev-note"></a>

## 开发备注

[运行器决策](../../.agents/notes/implemented/process/2026-09-06-preview-hosted-runner-sizing.zh.md) 记录测量、成本估算及镜像/CPU 差异。仅构建实验不验证生产部署。
