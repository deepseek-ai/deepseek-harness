/** Render historical format references from complete, validated in-tree schemas. */

import { readFileSync } from 'node:fs'
import { basename, join, posix } from 'node:path'
import { renderPersistencePair, type PersistenceArtifact } from './persistence-artifacts.ts'
import type { PersistenceFormatEntry, PersistenceFormats } from './persistence-formats.ts'
import { renderPersistenceSchemaDefinitions, renderPersistenceSchemaIndex } from './render-persistence-schema.ts'

type Language = 'en' | 'zh'

function replaceRegion(source: string, name: string, content: string, path: string): string {
  const start = `<!-- persistence-format-${name}:start -->`
  const end = `<!-- persistence-format-${name}:end -->`
  const opening = source.indexOf(start)
  const closing = source.indexOf(end)
  if (opening < 0 || closing < opening || source.indexOf(start, opening + start.length) >= 0
    || source.indexOf(end, closing + end.length) >= 0) throw new Error(`${path}: expected one ${name} factual block`)
  return source.slice(0, opening + start.length) + '\n\n' + content.trim() + '\n\n' + source.slice(closing)
}

function historicalSchema(entry: PersistenceFormatEntry, language: Language): string {
  const schema = basename(entry.schemaPath)
  const introduction = language === 'en'
    ? `The [complete machine inventory](${schema}) contains ${entry.inventory.roots.length} roots and ${entry.inventory.types.length} reachable types. Digests include all referenced fields; source names and paths describe the selected historical tree.`
    : `[完整机器目录](${schema})包含 ${entry.inventory.roots.length} 个根类型和 ${entry.inventory.types.length} 种可达类型。摘要包含所有引用字段；源码名称和路径描述所选的历史源码树。`
  return [
    '<a id="schema"></a>',
    language === 'en' ? '## Complete schemas' : '## 完整 schema',
    '',
    introduction,
    '',
    renderPersistenceSchemaIndex(entry.inventory, language, [], 3),
    '<details>',
    language === 'en' ? '<summary>Complete resolved types</summary>' : '<summary>完整解析类型</summary>',
    '',
    renderPersistenceSchemaDefinitions(entry.inventory, language, () => undefined, 3),
    '</details>',
  ].join('\n')
}

function formatIndex(formats: PersistenceFormats, language: Language): string {
  const path = (target: string): string => posix.relative('docs/persistence-changes/historical-formats',
    language === 'zh' && target.endsWith('.md') ? target.replace(/\.md$/u, '.zh.md') : target)
  return [
    language === 'en' ? '| Format | Source | Reference | Machine schema | Roots / types |' : '| 格式 | 来源 | 参考文档 | 机器 schema | 根类型 / 类型 |',
    '|---|---|---|---|---|',
    ...formats.entries.map((entry) => {
      const source = entry.source === undefined ? language === 'en' ? 'Current checkout' : '当前工作树'
        : 'tag' in entry.source ? `\`${entry.source.tag}\`` : `PR #${entry.source.pullRequest}`
      const label = entry.version === formats.currentVersion ? language === 'en' ? 'Current catalog' : '当前目录' : `V${entry.version}`
      return `| ${entry.version} | ${source} | [${label}](${path(entry.document)}) | [JSON](${path(entry.schemaPath)}) | ${entry.inventory.roots.length} / ${entry.inventory.types.length} |`
    }),
  ].join('\n')
}

/**
 * Refresh bounded schema regions and the format index, preserving authored evidence.
 * @param root - repository with both document languages and factual markers.
 * @param formats - complete validated versions through the current writer.
 * @returns paired references and consistency records without modifying files.
 */
export function persistenceFormatFactArtifacts(root: string, formats: PersistenceFormats): PersistenceArtifact[] {
  const artifacts: PersistenceArtifact[] = []
  for (const entry of formats.entries.filter(entry => entry.version < formats.currentVersion)) {
    const render = (language: Language): string => {
      const path = language === 'en' ? entry.document : entry.document.replace(/\.md$/u, '.zh.md')
      return replaceRegion(readFileSync(join(root, path), 'utf8'), 'schema', historicalSchema(entry, language), path)
    }
    artifacts.push(...renderPersistencePair(root, entry.document, render('en'), render('zh')))
  }
  const index = 'docs/persistence-changes/historical-formats/README.md'
  const renderIndex = (language: Language): string => {
    const path = language === 'en' ? index : index.replace(/\.md$/u, '.zh.md')
    return replaceRegion(readFileSync(join(root, path), 'utf8'), 'index', formatIndex(formats, language), path)
  }
  artifacts.push(...renderPersistencePair(root, index, renderIndex('en'), renderIndex('zh')))
  return artifacts
}
