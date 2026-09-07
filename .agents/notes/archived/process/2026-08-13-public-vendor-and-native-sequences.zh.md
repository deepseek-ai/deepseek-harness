# Agent Note: 按发布序列区分 npm access:vendored 框架与 native 包公开发布

Status: implemented
Archived: 2026-09-04

[English](2026-08-13-public-vendor-and-native-sequences.md) | 中文

## Problem

[三条发布序列](2026-08-10-npm-release-sequences.zh.md)交付时带的是 `publishConfig.access: restricted`,因此发到 `@deepseek-ai` scope 的每个包只在组织内可见。五次排练发布都是这样跑的:`dsh@0.0.1-rc.5`、vendor 的 `*-rc.4`、`landlock-run@0.0.1`。

真正卡住公开消费者的是**受限的依赖**。每个 harness 包都把 vendored 框架声明成 `peerDependency`,`dsh-sandbox-local` 把 Landlock 入口声明成 `dependency`。一个公开包若要求一个受限包,组织外的人根本装不上;所以这两条序列必须先公开,dsh 族才可能公开 —— 而在 dsh 族仍受限期间,它们也正是外部消费者唯一需要解析到的两条。

## Decision

access 是每条发布序列的属性,不是整个 scope 的属性:

| 序列 | 成员 | `publishConfig.access` |
|---|---|---|
| vendored 框架 | `vendor/*` 九包 | `public` |
| native | `native/landlock-run/packages/*` 三包 | `public` |
| dsh | `packages/*/*` + `apps/*`(221 个成员) | `restricted` |

`check-workspace-constraints.ts` 按各自序列的级别校验每个 manifest,这是阻止 scope 漂移的那道闸:新增的 `vendor/*` 包留在 `restricted`、或某个 dsh 成员被改成 `public`,都会让 workspace 约束失败。

**没有任何发布路径传 `--access`。** 一个选项无法服务级别互不相同的序列,而且选项会覆盖真正拥有这个事实的 manifest —— 所以 `publish.ts` 不传,native 的 workflow 也照旧不传,由各 packed manifest 决定。

harness 消费方引用 Landlock 入口改用 `workspace:^` 而非 `workspace:*`,于是发布出去的 harness 包接受该入口的 patch 与 minor 版本,而不是钉死一个精确版本。入口对它那两个平台包仍保持 `workspace:*` —— 那里二进制必须与入口版本完全一致。

access 是包的属性、不是版本的属性:已经以 restricted 发布的这十二个包(`landlock-run@0.0.1` 与 vendored 的 `*-rc.*`)会在**下一次发布**时变为全网可读。

## Alternatives considered

**一次性把整个 scope 改成 public。**不予采纳：这会让一次 dsh 发布因 manifest 改动而顺带公开，而不是来自刻意的发布决定。先公开两条依赖序列，能让每一步的已发布包都保持可安装，也是公开 dsh 的前置条件。

**全部保持受限,改为授予一个只读 team。** `npm access grant read-only <org:team> <包>` 是逐包的、没有 scope 通配,覆盖全集意味着每个包一次 grant,外加一个为后续新增包长期补齐的对账任务。它也只能覆盖组织成员,无法服务一个可安装的公开产物。

**在发布路径而不是 manifest 里指定公开。** 混合 scope 下不可能 —— 一个 `--access` 选项表达不了两种级别 —— 而且它会覆盖 workspace 约束正在校验的那个 manifest。

## Consequences

- **这十二个包从下一次发布起就是公开的,而且不能干净地回退。** 回到受限 scope 需要付费套餐加逐包 `npm access set status=private`,且已经被下载或镜像的内容收不回来。
- **`@deepseek-ai/dsh` 仍然装不了(组织外)。** 它的 manifest 保持 `restricted`;变化的是它已发布的依赖不再受限,所以将来公开它是一个版本决定,而不再是依赖问题。
- **两条公开序列交付的内容成为全网可读,它们的 payload 策略分量因此变重。** `vendor/cordis` 有意发布 `src`,因为其导出映射声明了 `./src/*`;Landlock 入口按既有约定发布 `src/main.c` 作为审计面。
- **这两条序列不再需要私有包套餐。** 阻塞过首次 native 发布的 `402 Payment Required` 失败形态对公开包不会再出现。
- **对公开序列,无凭据的 `npm view` 成为一个可用的检查手段。** 在所有包都受限的时期,没有凭据的机器对一个确实存在的包会收到 `E404`,与「版本不存在」无法区分。
