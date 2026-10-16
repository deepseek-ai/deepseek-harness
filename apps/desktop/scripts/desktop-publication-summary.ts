/** Render the verified publication plan for GitHub's native deployment reviewers. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { DesktopRetainedSource } from './desktop-release-store.ts'
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
 * @param plan Validated upload plan; YAML contents are the bytes that will be uploaded.
 * @param approval Digest bound to the approved manifest and upload plan.
 * File SHA-256 hex supports `shasum -a 256` on downloads; upload reconciliation separately uses SHA-512 base64.
 * @returns GitHub-flavored Markdown with final URLs and upload-byte fingerprints, without credentials or local paths.
 */
export async function desktopPublicationSummary(
  source: DesktopRetainedSource, plan: DesktopUploadPlan, approval: string,
): Promise<string> {
  const origin = new URL(plan.publicUrl).origin
  const url = (key: string) => `${origin}/${key.split('/').map(encodeURIComponent).join('/')}`
  const files = []
  for (const file of plan.artifacts) {
    const hash = createHash('sha256')
    let size = 0
    const bytes = file.contents === undefined ? createReadStream(file.path) : [Buffer.from(file.contents)]
    for await (const chunk of bytes) { size += chunk.length; hash.update(chunk) }
    files.push(row(link(url(file.key), file.filename), `${size} 字节 | ${code(hash.digest('hex'))}`))
  }
  const installerExtension = plan.target === 'win-x64' ? '.exe' : '.dmg'
  const installers = plan.artifacts.filter(file => !file.channelMetadata && file.filename.endsWith(installerExtension))
  const feeds = plan.artifacts.filter(file => file.channelMetadata)
  const runUrl = `https://github.com/${source.repository}/actions/runs/${source.runId}/attempts/${source.attempt}`
  const environment = plan.environment === 'test' ? 'desktop-test' : 'desktop-production'
  const tag = plan.environment === 'production' ? code(`desktop-v${plan.version}`) : '不创建（test 环境）'
  return [
    '', '## 发布前确认', '',
    `核对以下信息后，点击 **Review deployments**，选择 ${code(environment)} 并点击 **Approve and deploy**；信息有误请点击 **Reject**。`, '',
    '| 项目 | 发布信息 |', '| --- | --- |',
    row('发布环境', code(plan.environment)),
    row('版本号', code(plan.version)),
    row('升级通道', code(source.channel)),
    row('平台', code(plan.target)),
    ...(plan.environment === 'test' ? [row('测试 release ID', `${code(source.testReleaseId!)}<br>测试下载路径的随机前缀，用于降低地址被猜到的可能性；连续升级测试需使用相同值。`)] : []),
    row('下载地址预览', `${installers.map(file => link(url(file.key))).join('<br>')}<br>发布后的目标地址，审批前不保证可下载。`),
    row('升级 YAML', `${feeds.map(file => link(url(file.key))).join('<br>')}<br>本次发布将更新此文件；审批前可能不存在或仍指向旧版本。`),
    row('打包来源', `${link(runUrl, `查看打包运行 #${source.runId} · 第 ${source.attempt} 次尝试`)}<br>源码：${code(`${source.sourceRef} @ ${source.commit}`)}<br>打包机器：${code(source.runnerName)}`),
    row('签名与公证', plan.target === 'win-x64' ? 'EXE 签名校验通过' : 'DMG 校验通过<br>ZIP 内应用校验通过'),
    row('Git tag', tag), '', '### 批准后将执行', '',
    '1. 重新校验产物与发布目标；若与审批摘要不一致则停止。',
    '2. 上传缺少的文件，跳过内容一致的已有文件；发现内容冲突则停止。',
    '3. 更新上述升级 YAML，并保存发布记录。',
    ...(plan.environment === 'production' ? ['4. 为实际打包提交创建上述 Git tag；若 tag 创建失败，记录“已发布，待补 tag”。'] : []), '',
    ...(plan.environment === 'test' ? ['**本次只发布 test，不修改 production。**', ''] : []),
    '<details>', '<summary>技术详情与文件清单</summary>', '',
    `COS 存储桶：${code(plan.bucket)}`, '',
    ...(plan.environment === 'test' ? [
      'release ID 取自原打包产物清单。打包时优先使用表单 `test_release_id`；留空则使用机器 `presets/test.env` 中的 `DOWNLOAD_TEST_RELEASE_ID`。发布时不重新选择。', '',
    ] : []),
    `审批摘要 SHA-256：${code(approval)}`, '',
    `共 ${plan.artifacts.length} 个文件；大小及 SHA-256 对应实际上传字节，包括更新后的 YAML 内容。`, '',
    '| 文件 | 大小 | SHA-256 |', '| --- | --- | --- |', ...files, '', '</details>', '',
    '若仓库为公开仓库，此摘要中的下载路径及 test 发布的 release ID 也会公开。随机前缀不能替代访问鉴权。', '',
  ].join('\n')
}
