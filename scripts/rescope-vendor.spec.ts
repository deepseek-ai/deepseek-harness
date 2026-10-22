/** Recorded npm evidence stays intact while authored files and exact edits remain checked. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { exactEditState, isRescopeExcluded, rescopeText } from './rescope-vendor.ts'

const ANCHOR = '\n## Sync procedure'
const INSERTED = `\n15. **rescope**: one log entry.\n${ANCHOR}`

function expectRoundTrip(file: string, text: string, scoped: string, lines: number): void {
  expect(rescopeText(text, file)).toEqual({ text: scoped, lines })
  expect(rescopeText(scoped, file)).toEqual({ text: scoped, lines: 0 })
  expect(rescopeText(scoped, file, true)).toEqual({ text, lines })
}

describe('rescope file selection', () => {
  it('preserves the recorded npm resolution', () => {
    expect(isRescopeExcluded('scripts/dependency-catalog/package-lock.json')).toBe(true)
  })

  it.each([
    'scripts/dependency-catalog/package.json',
    'scripts/dependency-catalog/source.ts',
    'scripts/other/package-lock.json',
    'packages/example/src/index.ts',
    'packages/example/package.json',
  ])('keeps %s subject to upstream package-name checks', (file) => {
    expect(isRescopeExcluded(file)).toBe(false)
  })
})

describe('exactEditState', () => {
  it('classifies an insertion by its target form, so a duplicate is invalid', () => {
    expect(exactEditState(`log\n${ANCHOR}\n`, ANCHOR, INSERTED, 1)).toBe('pending')
    expect(exactEditState(`log${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('applied')
    // The anchor survives an insertion, so counting the source form would have
    // called this pending and inserted the entry a second time.
    expect(exactEditState(`log${INSERTED}${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('invalid')
    expect(exactEditState('log\n', ANCHOR, INSERTED, 1)).toBe('invalid')
  })

  it('classifies a deletion by its source form, and requires its remainder to survive', () => {
    const remainder = 'exclude:\n'
    const withEntries = 'exclude:\n  - cordis@4\n'
    expect(exactEditState(withEntries, withEntries, remainder, 1)).toBe('pending')
    expect(exactEditState(remainder, withEntries, remainder, 1)).toBe('applied')
    // Upstream dropped the whole field: the source form is gone, but so is the
    // remainder, so this is a moved site rather than a completed deletion.
    expect(exactEditState('unrelated:\n', withEntries, remainder, 1)).toBe('invalid')
  })

  it('requires a replacement to leave no source form and the exact target count', () => {
    expect(exactEditState('a = 1\n', 'a = 1', 'b = 2', 1)).toBe('pending')
    expect(exactEditState('b = 2\n', 'a = 1', 'b = 2', 1)).toBe('applied')
    expect(exactEditState('b = 2\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    // A moved or partially applied site: neither state is complete.
    expect(exactEditState('a = 1\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    expect(exactEditState('x\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
  })
})

describe('product identifiers', () => {
  it.each([
    'apps/cli/tests/optional-bundle-transitions.e2e.ts',
    'apps/web/tests/agent-preset-selection.e2e.ts',
    'apps/web/tests/developer-tools-settings.e2e.ts',
    'docs/subsystems/schedule.md',
    'docs/subsystems/schedule.zh.md',
    'docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.md',
    'docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.zh.md',
    'docs/upgrade-guide/v0.2.1-alpha.1/subagent-preset-composition/guide.md',
    'docs/upgrade-guide/v0.2.1-alpha.1/subagent-preset-composition/guide.zh.md',
    'docs/user/guide/schedule.md',
    'docs/user/guide/schedule.zh.md',
    'packages/bundle/web-app/cordis.patch.yml',
    'packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx',
    'packages/client/ui-agent-preset/src/client/analytics.ts',
    'packages/client/ui-agent-preset/tests/analytics.client.spec.ts',
    'packages/client/ui-agent-preset/tests/components.client.spec.tsx',
    'packages/client/ui-agent-preset/tests/create-plugin-menu-item.client.spec.tsx',
    'packages/client/ui-agent-preset/tests/section-store.client.spec.ts',
    'packages/client/ui-conversation/src/client/input/submission-analytics.ts',
    'packages/client/ui-conversation/tests/service-orchestration.client.spec.ts',
    'packages/client/ui-entry-customization/src/client/index.ts',
    'packages/client/ui-entry-customization/tests/menu.client.spec.tsx',
    'packages/client/ui-workspace/tests/workspaces-service.client.spec.ts',
    'packages/extensions/cordis-host-runner/tests/inspect-registry.spec.ts',
    'snapshots/session/cordis-inspect-liveness/client-fixture.mjs',
    'snapshots/session/cordis-inspect-timeout/client-fixture.mjs',
  ])('preserves the product values in %s', (file) => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    expect(text).toMatch(/(['"`])cordis(?:\/inspect-query(?:-resolved)?)?\1/)
    expect(isRescopeExcluded(file)).toBe(false)
    expect(rescopeText(text, file)).toEqual({ text, lines: 0 })
  })

  it('still renames other libraries in a preset consumer and reverses them', () => {
    const file = 'packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx'
    const text = "const preset = 'cordis'\nimport utils from 'cosmokit'\nimport Schema from 'schemastery'\n"
    const scoped = "const preset = 'cordis'\nimport utils from '@deepseek-ai/cosmokit'\nimport Schema from '@deepseek-ai/schemastery'\n"
    expect(rescopeText(text, file)).toEqual({ text: scoped, lines: 2 })
    expect(rescopeText(scoped, file)).toEqual({ text: scoped, lines: 0 })
    expect(rescopeText(scoped, file, true)).toEqual({ text, lines: 2 })
  })

  it('keeps unlisted package references subject to residue detection', () => {
    const file = 'packages/example/src/index.ts'
    const text = "import { Context } from 'cordis'\nimport type Schema from 'schemastery'\n"
    const scoped = "import { Context } from '@deepseek-ai/cordis'\nimport type Schema from '@deepseek-ai/schemastery'\n"
    expect(rescopeText(text, file)).toEqual({ text: scoped, lines: 2 })
    expect(rescopeText(scoped, file)).toEqual({ text: scoped, lines: 0 })
    expect(rescopeText(scoped, file, true)).toEqual({ text, lines: 2 })
    expect(rescopeText("ctx.emit('cordis/inspect-query')", file).text).toBe("ctx.emit('@deepseek-ai/cordis/inspect-query')")
  })

  it.each([
    ['import', "import { Context } from 'cordis'", "import { Context } from '@deepseek-ai/cordis'"],
    ['multiline import', "import {\n  Context,\n} from 'cordis'", "import {\n  Context,\n} from '@deepseek-ai/cordis'"],
    ['side-effect import', "import 'cordis'", "import '@deepseek-ai/cordis'"],
    ['export', "export { Context } from 'cordis/subpath'", "export { Context } from '@deepseek-ai/cordis/subpath'"],
    ['import equals', "import Cordis = require('cordis')", "import Cordis = require('@deepseek-ai/cordis')"],
    ['dynamic import', 'const cordis = import(`cordis`)', 'const cordis = import(`@deepseek-ai/cordis`)'],
    ['require', 'const cordis = require("cordis/subpath")', 'const cordis = require("@deepseek-ai/cordis/subpath")'],
    ['import type', "type Context = import('cordis').Context", "type Context = import('@deepseek-ai/cordis').Context"],
    ['module declaration', "declare module 'cordis' {}", "declare module '@deepseek-ai/cordis' {}"],
    ['JSDoc type', "/** @param {import('cordis').Context} ctx */\nfunction apply(ctx) {}", "/** @param {import('@deepseek-ai/cordis').Context} ctx */\nfunction apply(ctx) {}"],
    ['JSDoc import', "/** @import { Context } from 'cordis' */\nfunction apply(ctx) {}", "/** @import { Context } from '@deepseek-ai/cordis' */\nfunction apply(ctx) {}"],
    ['same-line imports', "import 'cordis'; import 'cordis/subpath'", "import '@deepseek-ai/cordis'; import '@deepseek-ai/cordis/subpath'"],
  ])('rewrites %s without changing same-file product data', (_label, source, target) => {
    const file = 'packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx'
    const product = "const preset = 'cordis'\nctx.emit('cordis/inspect-query')\nconst fixture = \"import 'cordis'\"\n"
    const text = `${product}${source}\n`
    const scoped = `${product}${target}\n`
    expectRoundTrip(file, text, scoped, 1)
  })

  it.each([
    ['apps/cli/tests/optional-bundle-transitions.e2e.ts', 1],
    ['packages/client/ui-conversation/src/client/input/submission-analytics.ts', 1],
    ['packages/client/ui-conversation/tests/service-orchestration.client.spec.ts', 1],
    ['packages/client/ui-entry-customization/src/client/index.ts', 1],
    ['packages/client/ui-entry-customization/tests/menu.client.spec.tsx', 1],
    ['packages/client/ui-workspace/tests/workspaces-service.client.spec.ts', 1],
    ['packages/extensions/cordis-host-runner/tests/inspect-registry.spec.ts', 2],
    ['snapshots/session/cordis-inspect-liveness/client-fixture.mjs', 1],
    ['snapshots/session/cordis-inspect-timeout/client-fixture.mjs', 2],
  ] as const)('reverses real package references in %s and restores them', (file, lines) => {
    const scoped = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const text = scoped.replaceAll("'@deepseek-ai/cordis'", "'cordis'")
    expect(text).not.toBe(scoped)
    expectRoundTrip(file, text, scoped, lines)
    expect(rescopeText(text, file, true)).toEqual({ text, lines: 0 })
  })

  it('rewrites multiline fenced imports while preserving prose and fenced product data', () => {
    const file = 'docs/subsystems/schedule.md'
    const text = "The `cordis` preset.\n```ts\nconst preset = 'cordis'\nimport {\n  Context,\n} from 'cordis'\n```\n"
    const scoped = "The `cordis` preset.\n```ts\nconst preset = 'cordis'\nimport {\n  Context,\n} from '@deepseek-ai/cordis'\n```\n"
    expectRoundTrip(file, text, scoped, 1)
  })

  it.each(['cordis', "'cordis'", '"cordis/subpath"'])('rewrites the YAML name %s without changing product comments', (name) => {
    const text = `# The 'cordis' preset.\n- name: ${name} # 'cordis' stays product data\n`
    const scoped = `# The 'cordis' preset.\n- name: ${name.replace('cordis', '@deepseek-ai/cordis')} # 'cordis' stays product data\n`
    for (const [file, wrap] of [
      ['packages/bundle/web-app/cordis.patch.yml', (value: string) => value],
      ['docs/subsystems/schedule.md', (value: string) => `The \`cordis\` preset.\n\`\`\`yaml\n${value}\`\`\`\n`],
    ] as const) {
      expectRoundTrip(file, wrap(text), wrap(scoped), 1)
    }
  })

  it.each(['scripts/rescope-vendor.spec.ts', 'scripts/gen-third-party-notices.spec.ts'])('keeps both package spellings in the fixture owner %s', (file) => {
    const text = "import 'cordis'\nimport '@deepseek-ai/cordis'\nconst fixture = \"import 'cosmokit'\"\n"
    expect(rescopeText(text, file)).toEqual({ text, lines: 0 })
    expect(rescopeText(text, file, true)).toEqual({ text, lines: 0 })
  })

  it('keeps schema runtime identifiers while rewriting their same-file import', () => {
    const file = 'vendor/loader/src/config/diff.ts'
    const text = "const key = Symbol.for('schemastery')\nconst metadata = { vendor: 'schemastery' }\nimport Schema from 'schemastery'\n"
    const scoped = "const key = Symbol.for('schemastery')\nconst metadata = { vendor: 'schemastery' }\nimport Schema from '@deepseek-ai/schemastery'\n"
    expectRoundTrip(file, text, scoped, 1)
  })

  it('rewrites declarations in an older event-name exception', () => {
    const file = 'packages/extensions/cordis-host-runner/src/index.ts'
    const text = "ctx.emit('cordis/inspect-query')\nimport { Context } from 'cordis'\ndeclare module 'cordis' {}\n"
    const scoped = "ctx.emit('cordis/inspect-query')\nimport { Context } from '@deepseek-ai/cordis'\ndeclare module '@deepseek-ai/cordis' {}\n"
    expectRoundTrip(file, text, scoped, 2)
  })

  it.each(['```ts\n```\n', "```ts\nimport 'cordis'\n"])('keeps fence line counts without requiring a closing fence', (text) => {
    const file = 'docs/subsystems/schedule.md'
    const scoped = text.replace("import 'cordis'", "import '@deepseek-ai/cordis'")
    expectRoundTrip(file, text, scoped, scoped === text ? 0 : 1)
  })
})
