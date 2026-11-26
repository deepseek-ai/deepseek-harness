/** Render the verified publication plan for GitHub's native deployment reviewers. */
import { load } from 'js-yaml'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { desktopWebsiteInstallerUrl } from '@deepseek-ai/dsh-desktop-publisher/desktop-auto-update-environment.mjs'
import type { DesktopRetainedSource } from '@deepseek-ai/dsh-desktop-publisher/desktop-release-store.ts'
import type { DesktopUploadPlan } from './desktop-upload-plan.ts'

function text(value: string): string {
  return value.replace(/[&<>"'|`\r\n\\*_\[\]()!~:]/gu, character => `&#${character.charCodeAt(0)};`)
}

function code(value: string): string { return `<code>${text(value)}</code>` }
function row(label: string, value: string): string { return `| ${label} | ${value} |` }
function link(url: string, label = url): string { return `<a href="${text(url)}">${text(label)}</a>` }

/**
 * Render Chinese approval details after package, destination and signature verification succeeds.
 * @param source Verified retained packaging identity; a test plan requires its validated release ID.
 * @param plans Validated per-channel upload plans; YAML contents are the bytes that will be uploaded.
 * @param approval Digest bound to the approved manifest and upload plans.
 * File SHA-256 hex supports `shasum -a 256` on downloads; upload reconciliation separately uses SHA-512 base64.
 * @param uploadWebsite Whether the selected operation also replaces the production website installer.
 * @param bucketOverride Bucket name used when website-only publication has no channel upload plan.
 * @returns GitHub-flavored Markdown with final URLs and upload-byte fingerprints, without credentials or local paths.
 */
export async function desktopPublicationSummary(
  source: DesktopRetainedSource,
  plans: readonly { readonly channel: 'nightly' | 'stable'; readonly plan: DesktopUploadPlan }[],
  approval: string,
  uploadWebsite: boolean,
  bucketOverride?: string,
): Promise<string> {
  const first = plans[0]?.plan
  const environmentName = first?.environment ?? source.preset
  const target = first?.target ?? source.target
  const version = first?.version ?? source.version
  const bucket = first?.bucket ?? bucketOverride ?? ''
  const targetChannels = plans.map(entry => entry.channel)
  const files: string[] = []
  const installers: string[] = []
  const feeds: string[] = []
  const percentageRows: string[] = []
  const installerExtension = target === 'win-x64' ? '.exe' : '.dmg'
  for (const { channel, plan } of plans) {
    const origin = new URL(plan.publicUrl).origin
    const url = (key: string) => `${origin}/${key.split('/').map(encodeURIComponent).join('/')}`
    for (const file of plan.artifacts) {
      const hash = createHash('sha256')
      let size = 0
      const bytes = file.contents === undefined ? createReadStream(file.path) : [Buffer.from(file.contents)]
      for await (const chunk of bytes) { size += chunk.length; hash.update(chunk) }
      files.push(row(link(url(file.key), file.filename), `${size} 字节 | ${code(hash.digest('hex'))}`))
      if (!file.channelMetadata && file.filename.endsWith(installerExtension)) installers.push(link(url(file.key)))
      if (file.channelMetadata) {
        feeds.push(link(url(file.key)))
        const metadata = z.object({ stagingPercentage: z.number().optional() }).parse(load(file.contents!))
        const label = plans.length > 1 ? `更新灰度比例（${channel}）` : '更新灰度比例'
        percentageRows.push(row(label, metadata.stagingPercentage === undefined ? '全量（未设置）' : `${metadata.stagingPercentage}%`))
      }
    }
  }
  const runUrl = `https://github.com/${source.repository}/actions/runs/${source.runId}/attempts/${source.attempt}`
  const environment = environmentName === 'test' ? 'desktop-test' : 'desktop-production'
  const tag = plans.length > 0 && environmentName === 'production'
    ? code(`desktop-v${version}`)
    : environmentName === 'test' ? '不创建（test 环境）' : '不创建（仅发布官网安装包）'
  return [
    '', '## 发布前确认', '',
    `核对以下信息后，点击 **Review deployments**，选择 ${code(environment)} 并点击 **Approve and deploy**；信息有误请点击 **Reject**。`, '',
    '| 项目 | 发布信息 |', '| --- | --- |',
    row('发布环境', code(environmentName)),
    row('版本号', code(version)),
    row('包内渠道标记', code(source.channel)),
    row('发布目标渠道', targetChannels.length > 0 ? targetChannels.map(channel => code(channel)).join('、') : '不发布自动更新渠道（仅官网安装包）'),
    ...percentageRows,
    row('平台', code(target)),
    ...(environmentName === 'test' ? [row('测试 release ID', `${code(source.testReleaseId!)}<br>测试下载路径的随机前缀，用于降低地址被猜到的可能性；连续升级测试需使用相同值。`)] : []),
    ...(plans.length > 0 ? [
      row('下载地址预览', `${installers.join('<br>')}<br>发布后的目标地址，审批前不保证可下载。`),
      row('升级 YAML', `${feeds.join('<br>')}<br>本次发布将更新此文件；审批前可能不存在或仍指向旧版本。`),
    ] : []),
    row('打包来源', `${link(runUrl, `查看打包运行 #${source.runId} · 第 ${source.attempt} 次尝试`)}<br>源码：${code(`${source.sourceRef} @ ${source.commit}`)}<br>打包机器：${code(source.runnerName)}`),
    row('签名与公证', target === 'win-x64' ? 'EXE 签名校验通过' : 'DMG 校验通过<br>ZIP 内应用校验通过'),
    ...(uploadWebsite && environmentName === 'production' ? [row('官网固定安装包',
      `${link(desktopWebsiteInstallerUrl(target))}<br>替换为版本 ${code(version)}；已有安装包会被替换，无防降级保护；官网上传与刷新在后续 job 中执行，可能需另行审批。`)] : []),
    row('Git tag', tag), '', '### 批准后将执行', '',
    ...(plans.length > 0 ? [
      '1. 重新校验产物与发布目标；若与审批摘要不一致则停止。',
      '2. 逐个所选渠道独立加锁，上传缺少的文件并跳过内容一致的已有文件；发现内容冲突则停止。',
      '3. 更新上述升级 YAML，并按单渠道保存独立发布记录。',
      ...(environmentName === 'production' ? ['4. 为实际打包提交创建上述 Git tag；若 tag 创建失败，记录“已发布，待补 tag”。'] : []),
    ] : [
      '1. 跳过自动更新渠道发布，由后续官网 job 校验生产安装包 SHA-512 后替换官网固定下载包并刷新缓存。',
    ]), '',
    ...(environmentName === 'test' ? ['**本次只发布 test，不修改 production。**', ''] : []),
    '<details>', '<summary>技术详情与文件清单</summary>', '',
    `COS 存储桶：${code(bucket)}`, '',
    ...(environmentName === 'test' ? [
      'release ID 取自原打包产物清单。打包时优先使用表单 `test_release_id`；留空则使用机器 `presets/test.env` 中的 `DOWNLOAD_TEST_RELEASE_ID`。发布时不重新选择。', '',
    ] : []),
    `审批摘要 SHA-256：${code(approval)}`, '',
    ...(files.length > 0 ? [
      `共 ${files.length} 个文件；大小及 SHA-256 对应实际上传字节，包括更新后的 YAML 内容。`, '',
      '| 文件 | 大小 | SHA-256 |', '| --- | --- | --- |', ...files, '',
    ] : ['本次未勾选自动更新渠道，无渠道文件上传清单。', '']),
    '</details>', '',
    '若仓库为公开仓库，此摘要中的下载路径及 test 发布的 release ID 也会公开。随机前缀不能替代访问鉴权。', '',
  ].join('\n')
}
