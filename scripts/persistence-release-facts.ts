/** Render bounded release facts from validated offline records while preserving authored prose. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderPersistencePair } from './persistence-artifacts.ts'
import type { PersistenceArtifact } from './persistence-artifacts.ts'
import type { PersistenceReleaseEntry, PersistenceReleases } from './persistence-releases.ts'
import { canonicalizeSchema, schemaDigest } from './persistence-schema-model.ts'

type Language = 'en' | 'zh'

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

function replaceFacts(source: string, name: string, content: string, path: string): string {
  const start = `<!-- persistence-release-${name}:start -->`
  const end = `<!-- persistence-release-${name}:end -->`
  const opening = source.indexOf(start)
  const closing = source.indexOf(end)
  if (opening < 0 || closing < opening || source.indexOf(start, opening + start.length) >= 0
    || source.indexOf(end, closing + end.length) >= 0) throw new Error(`${path}: expected one ${name} factual block`)
  return source.slice(0, opening + start.length) + content + source.slice(closing)
}

function structuralChanges(entry: PersistenceReleaseEntry, language: Language): string {
  if (entry.record.previous === null) {
    return language === 'en'
      ? 'This entry establishes the historical comparison starting point. Its declaration lists every extracted root; it makes no compatibility judgment about earlier versions.'
      : '本条记录建立历史比较起点。机器声明列出所有提取的根类型，不对更早版本作兼容性判断。'
  }
  if (entry.differences.length === 0) {
    return language === 'en'
      ? 'Normalized root types and their transitive digests are unchanged from the preceding tag.'
      : '规范化后的根类型及其传递引用摘要与前一 tag 相同。'
  }
  const summary = language === 'en'
    ? `Detected ${count(entry.record.changes.length, 'changed root')} and ${count(entry.differences.length, 'structural difference')}. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.`
    : `检测到 ${entry.record.changes.length} 个根类型变化、${entry.differences.length} 项结构差异。下表的最低要求按当前规则计算，只用于比较；不表示旧版本曾遵守这些规则，也不证明迁移或运行时兼容性。`
  const heading = language === 'en' ? '| Path | Change | Current minimum |' : '| 路径 | 变化 | 当前最低要求 |'
  const rows = entry.differences.map((change) => {
    const path = change.path.replaceAll('`', '\\`').replaceAll('|', '\\|')
    return `| \`${path}\` | \`${change.kind}\` | \`${change.requiresVersionBump ? 'version-bump' : 'same-version'}\` |`
  })
  return [summary, '', heading, '|---|---|---|', ...rows].join('\n')
}

/** Compute paired factual updates without writing or changing machine declarations.
 * @param root - checkout containing existing documents with bounded factual markers.
 * @param archive - fully validated release records and reconstructed roots.
 * @returns complete bilingual documents and sidecars, validated together before any caller writes.
 */
export function persistenceReleaseFactArtifacts(root: string, archive: PersistenceReleases): PersistenceArtifact[] {
  const directory = 'docs/persistence-changes/releases'
  const rootTypes = new Map<string, readonly string[]>()
  const typeCounts = archive.entries.map((entry) => {
    const types = new Set<string>()
    for (const root of entry.roots.values()) {
      let digests = rootTypes.get(root.digest)
      if (digests === undefined) {
        digests = root.schema.nodes.map((_, index) => schemaDigest(canonicalizeSchema(root.schema.nodes, index)))
        rootTypes.set(root.digest, digests)
      }
      for (const digest of digests) types.add(digest)
    }
    return types.size
  })
  const read = (name: string): string => readFileSync(join(root, directory, name), 'utf8')
  const index = (language: Language): string => {
    const heading = language === 'en'
      ? '| Tag | Source date (UTC) | Session version | Roots / types | Changed roots |'
      : '| Tag | 源码日期（UTC） | Session 版本 | 根 / 类型 | 变化根 |'
    const rows = archive.entries.map((entry, index) => {
      const tag = entry.release.tag
      const date = new Date(entry.release.sourceDate).toISOString().slice(0, 10)
      return `| [${tag}](${tag}${language === 'zh' ? '.zh' : ''}.md) | ${date} | ${entry.release.sessionFormatVersion} | ${entry.roots.size} / ${typeCounts[index]} | ${entry.record.changes.length} |`
    })
    return '\n\n' + [heading, '|---|---|---|---|---|', ...rows].join('\n') + '\n\n'
  }
  const artifacts = renderPersistencePair(root, `${directory}/README.md`,
    replaceFacts(read('README.md'), 'index', index('en'), 'README.md'),
    replaceFacts(read('README.zh.md'), 'index', index('zh'), 'README.zh.md'))
  for (const [index, entry] of archive.entries.entries()) {
    const document = (language: Language): string => {
      const path = `${entry.release.tag}${language === 'zh' ? '.zh' : ''}.md`
      const inventory = language === 'en'
        ? `${count(entry.roots.size, 'root')} / ${count(typeCounts[index] as number, 'type')}`
        : `${entry.roots.size} 个根类型 / ${typeCounts[index]} 种类型`
      return replaceFacts(replaceFacts(read(path), 'inventory', inventory, path),
        'changes', '\n\n' + structuralChanges(entry, language) + '\n\n', path)
    }
    artifacts.push(...renderPersistencePair(root, `${directory}/${entry.release.tag}.md`, document('en'), document('zh')))
  }
  return artifacts
}
