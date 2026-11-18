# Agent Note: Runtime download of upstream skills

Status: implemented

English | [中文](2026-10-28-upstream-skills-runtime-download.zh.md)

## Problem

The WeCom and Tencent Meeting plugins index guides that their vendors publish only in their GitHub repositories: 180 files, about 1.75 MB, for WeCom and 11 for Tencent Meeting. A copy in this repository dominates each plugin's diff and every upstream update, and the plugins' npm packages would publish DeepSeek's copy of another company's content. DeepSeek does not publish such copies.

## Decision

Each of these plugins keeps only its DSH-authored entry `SKILL.md`, pins the upstream files by repository, commit, kept directory, exclusions, license file, total size, and a digest of the kept files, and registers both with `ctx.upstreamSkills`, the Service of [`@deepseek-ai/dsh-upstream-skills`](../../../../packages/connector/upstream-skills/README.md). The Service downloads the commit archive from GitHub when the plugin loads, keeps the directory and the license file, verifies them, publishes them in `$DSH_HOME/cache/<plugin>`, and lists the entry skill with that directory as its base directory. The plugin shows the download state beside the account state. Its check reads only the account and restarts a failed download without waiting for it: the CLI account runtime runs one operation at a time, so a check that waited for a slow GitHub download would also hold sign-in. Each archive source has `skillsTimeoutMs` to deliver the whole archive, and reading stops once the kept files exceed the pinned size. A plugin's `skillsDir` points at prepared files for tests and offline installations, and the Service's `skillsUrls` replaces the archive host for every plugin.

## Alternatives considered

**A copy in this repository.** It was the earlier approach. Byte-identical copies dominate review and upstream updates, and the plugins' npm packages republish them.

**A DSH-published package of the upstream files.** It moves the copy out of this repository, but it is still DeepSeek's own publication of another company's content.

**The vendors' npm packages.** Neither `@wecom/cli` nor `@tencentcloud/tmeet` ships the skills.

**jsDelivr or one request per file.** A CDN adds a third party between the vendor and the user. Per-file downloads need the file list in the pin and one request per file, while one archive per commit needs one request and lets the digest cover exactly what is kept.

**A digest of the archive bytes.** The files of a commit archive are stable, but GitHub does not keep its compressed bytes stable, so the digest covers the kept files' paths and contents instead.

**DingTalk's downloader.** DingTalk downloads checksummed release assets together with its executable. WeCom and Tencent Meeting publish no release assets and install their CLIs from npm, so only these two plugins register with this Service, and DingTalk keeps its own downloader.

## Consequences

The repository and the plugins' npm packages carry only the entry skills. The first load after a new pin needs GitHub or a configured mirror; until a download succeeds, the entry skill is not listed and the plugin shows the failure, which its next check retries. Tests, recorded Sessions, and Web end-to-end tests set `skillsDir` to fixture files and make no network requests. Published directories are never pruned. Updating a pin is a code change: `scripts/upstream-skills-digest.ts` prints the new pin, and the entry's guide index and a real-model run follow it.
