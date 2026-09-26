/**
 * Generate the loadable-plugin package list shipped inside the
 * `cordis-composition-reference` skill from the workspace manifests and the
 * config-catalog classification. `--check` exits 1 when the committed file is stale.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectConfigCatalog, type CatalogEntry } from './gen-config-catalog.ts'

const root = resolve(import.meta.dirname, '..')
const OUT = 'packages/preset/agent-preset/skills/cordis-composition-reference/references/packages.md'

interface Row {
  pkg: string
  group: string
  config: boolean
  description: string
}

function rows(entries: readonly CatalogEntry[]): Row[] {
  const result: Row[] = []
  for (const entry of entries) {
    // Seams are abstract Service Definitions and libraries export no plugin; neither is a Loader row.
    if (entry.kind !== 'config' && entry.kind !== 'no-config') continue
    const manifest = JSON.parse(readFileSync(resolve(root, entry.dir, 'package.json'), 'utf8')) as { description: string }
    // Catalog dirs are `packages/<group>/<pkg>`, so the group segment is always present.
    const group = entry.dir.split('/')[1] ?? entry.dir
    result.push({ pkg: entry.pkg, group, config: entry.kind === 'config', description: manifest.description })
  }
  return result.sort((left, right) => left.group.localeCompare(right.group) || left.pkg.localeCompare(right.pkg))
}

/**
 * Render the package list as one Markdown document grouped by package group.
 * @param entries - config-catalog entries for every workspace package.
 * @returns the complete file content.
 */
export function render(entries: readonly CatalogEntry[]): string {
  const lines = [
    '# Loadable Harness plugin packages',
    '',
    'This file is GENERATED from workspace manifests (`scripts/gen-plugin-packages.ts`) and verified fresh by `pnpm run verify-plugin-packages` (part of `doc-sync`); do not edit it by hand.',
    '',
    'Every package below exports a Cordis plugin that a bundle patch can name in a Loader row. `Config` marks packages whose row accepts a `config` mapping; query `Config.listConfigs` through `cordis_inspect_query` (filter by `name`, then query the `entry` id) for the mounted schema. Packages under `experimental` are pre-stable.',
    '',
  ]
  let group = ''
  for (const row of rows(entries)) {
    if (row.group !== group) {
      if (group !== '') lines.push('')
      group = row.group
      lines.push(`## ${group}`, '', '| Package | Config | Description |', '|---|---|---|')
    }
    lines.push(`| \`${row.pkg}\` | ${row.config ? 'yes' : 'no'} | ${row.description} |`)
  }
  return `${lines.join('\n')}\n`
}

function main(): void {
  const content = render(collectConfigCatalog())
  if (process.argv.includes('--check')) {
    let committed: string | null
    try {
      committed = readFileSync(resolve(root, OUT), 'utf8')
    } catch {
      // A missing or unreadable file has the same remedy as a stale one: regenerate.
      committed = null
    }
    if (committed === content) {
      console.log(`gen-plugin-packages: ${OUT} is up to date.`)
      process.exit(0)
    }
    console.error(`gen-plugin-packages: ${OUT} is stale. Run \`pnpm run gen-plugin-packages\` and commit ${OUT}.`)
    process.exit(1)
  }
  writeFileSync(resolve(root, OUT), content)
  console.log(`gen-plugin-packages: wrote ${OUT}.`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
