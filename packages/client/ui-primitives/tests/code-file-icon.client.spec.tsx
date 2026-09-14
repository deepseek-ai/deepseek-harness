// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyFileType, FileTypeIcon, type CodeFileType, type FileTypeProjectContext,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { CODE_FILE_ARTWORK, CODE_FILE_ICON_ID_TOKEN } from '../src/code-file-icon-artwork.ts'
import { CODE_FILE_TYPES } from '../src/code-file-types.ts'

afterEach(cleanup)

const flutter: FileTypeProjectContext = {
  files: { 'config/pubspec.yaml': 'name: demo\ndependencies:\n  flutter: sdk' },
}

function normalizeCodeIconIds(html: string): string {
  return html.replace(/dsh-code-icon-[A-Za-z0-9_-]+/gu, 'dsh-code-icon-instance')
}

describe('code-file classification', () => {
  it.each([
    ['app.component.ts', 'angular'],
    ['file.c', 'c'],
    ['file.clj', 'clojure'],
    ['CMakeLists.txt', 'cmake'],
    ['file.cc', 'cpp'],
    ['file.cs', 'csharp'],
    ['file.css', 'css'],
    ['file.dart', 'dart'],
    ['Dockerfile', 'docker'],
    ['file.ex', 'elixir'],
    ['.env', 'env'],
    ['file.erl', 'erlang'],
    ['.gitignore', 'git'],
    ['file.go', 'go'],
    ['file.graphql', 'graphql'],
    ['file.hs', 'haskell'],
    ['file.ini', 'ini'],
    ['file.java', 'java'],
    ['file.js', 'javascript'],
    ['file.json', 'json'],
    ['file.kt', 'kotlin'],
    ['file.lua', 'lua'],
    ['Makefile', 'makefile'],
    ['package.json', 'node'],
    ['file.m', 'objective-c'],
    ['file.pl', 'perl'],
    ['file.php', 'php'],
    ['file.ps1', 'powershell'],
    ['file.proto', 'protobuf'],
    ['file.py', 'python'],
    ['file.r', 'r'],
    ['file.jsx', 'react'],
    ['Gemfile', 'ruby'],
    ['file.rs', 'rust'],
    ['file.scala', 'scala'],
    ['.bashrc', 'shell'],
    ['file.sol', 'solidity'],
    ['file.sql', 'sql'],
    ['file.svelte', 'svelte'],
    ['file.swift', 'swift'],
    ['file.toml', 'toml'],
    ['file.ts', 'typescript'],
    ['file.vue', 'vue'],
    ['file.wasm', 'wasm'],
    ['file.xml', 'xml'],
    ['file.yaml', 'yaml'],
    ['file.zig', 'zig'],
  ] as [string, CodeFileType][])('%s → %s', (path, type) => {
    expect(classifyFileType(path)).toBe(type)
  })

  it('applies filename priority before generic extensions', () => {
    expect(classifyFileType('package.json')).toBe('node')
    expect(classifyFileType('docker-compose.yaml')).toBe('docker')
    expect(classifyFileType('feature.component.ts')).toBe('angular')
    expect(classifyFileType('Dockerfile.local')).toBe('docker')
    expect(classifyFileType('.env.production')).toBe('env')
  })

  it('selects Flutter only when the supplied project snapshot identifies it', () => {
    expect(classifyFileType('lib/main.dart')).toBe('dart')
    expect(classifyFileType('lib/main.dart', { files: { 'pubspec.yaml': 'name: demo' } })).toBe('dart')
    expect(classifyFileType('lib/main.dart', flutter)).toBe('flutter')

    const view = render(<FileTypeIcon path="lib/main.dart" context={flutter} />)
    const explicit = render(<FileTypeIcon kind="flutter" />)
    expect(normalizeCodeIconIds(view.container.innerHTML))
      .toBe(normalizeCodeIconIds(explicit.container.innerHTML))
  })

  it('keeps Markdown and SVG on the traditional file artwork', () => {
    expect(classifyFileType('README.md')).toBe('markdown')
    expect(classifyFileType('logo.svg')).toBe('image')
  })
})

describe('full-color code-file artwork', () => {
  it('embeds exactly the established 48 code categories', () => {
    expect(Object.keys(CODE_FILE_ARTWORK)).toEqual([...CODE_FILE_TYPES])
    expect(CODE_FILE_ARTWORK).not.toHaveProperty('markdown')
    for (const [type, artwork] of Object.entries(CODE_FILE_ARTWORK)) {
      expect(artwork).not.toMatch(/<(?:script|style|foreignObject)\b|\son[a-z]+\s*=/iu)
      expect(artwork).not.toMatch(/(?:href|xlink:href)="(?!#)/iu)
      const ids = [...artwork.matchAll(/\bid="([^"]+)"/gu)].map(match => match[1]!)
      expect(new Set(ids).size, `${type} has duplicate SVG ids`).toBe(ids.length)
      for (const id of ids) expect(id).toMatch(new RegExp(`^${CODE_FILE_ICON_ID_TOKEN}`))
      const references = [
        ...[...artwork.matchAll(/url\(#([^)]+)\)/gu)].map(match => match[1]!),
        ...[...artwork.matchAll(/(?:href|xlink:href)="#([^"]+)"/gu)].map(match => match[1]!),
      ]
      for (const reference of references) {
        expect(reference).toMatch(new RegExp(`^${CODE_FILE_ICON_ID_TOKEN}`))
        expect(ids).toContain(reference)
      }
    }
  })

  it('records the design exports that supply the closed artwork set', () => {
    const path = resolve('packages/client/ui-primitives/src/code-file-icon-artwork.manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      owner: string
      sources: Array<{ kind: string; sha256: string; icons: string[] }>
      excluded: string[]
    }
    expect(manifest.owner).toBe('DeepSeek Harness product design')
    expect(manifest.sources.every(source => source.kind === 'internal-design-export')).toBe(true)
    expect(manifest.sources.every(source => /^[0-9a-f]{64}$/u.test(source.sha256))).toBe(true)
    expect(manifest.sources.flatMap(source => source.icons).sort()).toEqual([...CODE_FILE_TYPES].sort())
    expect(manifest.excluded).toEqual(['markdown'])
  })

  it.each(CODE_FILE_TYPES)('%s renders its supplied square SVG', (type) => {
    const { container } = render(<FileTypeIcon kind={type} />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 20 20')
    expect(svg.getAttribute('width')).toBe('28')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(container.innerHTML).toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(container.innerHTML).not.toContain('currentColor')
  })

  it('keeps every code category visually distinct', () => {
    const artwork = CODE_FILE_TYPES.map((type) => {
      const { container } = render(<FileTypeIcon kind={type} />)
      return container.querySelector('svg')!.innerHTML
    })
    expect(new Set(artwork).size).toBe(CODE_FILE_TYPES.length)
  })

  it('uses instance-safe gradient ids and forwards sizing classes', () => {
    const { container } = render(<><FileTypeIcon kind="elixir" /><FileTypeIcon kind="elixir" /></>)
    const ids = [...container.querySelectorAll('[id]')].map(element => element.id)
    expect(ids.length).toBeGreaterThan(2)
    expect(new Set(ids).size).toBe(ids.length)
    expect(container.innerHTML).not.toContain(CODE_FILE_ICON_ID_TOKEN)
    const references = [...container.querySelectorAll('*')].flatMap(element =>
      [...element.attributes].flatMap(attribute =>
        [...attribute.value.matchAll(/url\(#([^)]+)\)/gu)].map(match => match[1])),
    )
    expect(references.length).toBeGreaterThan(0)
    for (const reference of references) expect(ids).toContain(reference)

    const sized = render(<FileTypeIcon path="file.ts" size={16} className="x" />)
    const svg = sized.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('height')).toBe('16')
    expect(svg.classList.contains('x')).toBe(true)
  })
})
