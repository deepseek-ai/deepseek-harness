// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import {
  PACKAGE_ASSET_EXPORT, PACKAGE_ASSET_EXPORT_TARGET, PACKAGE_ASSET_MEDIA_TYPES, packageAssetReference,
} from '@deepseek-ai/dsh-client-modules/src/assets.ts'
import { packPackageAssets, packageAssetResolver } from '../src/package-assets.ts'
import { MemoryVfs } from '../src/storage/memory.ts'
import { parseTar } from '../src/storage/tar.ts'

const ROOT = '/dsh'

afterEach(() => { vi.unstubAllGlobals() })

/** Seed one installed package into the image filesystem. */
function seedPackage(vfs: MemoryVfs, name: string, exports: Record<string, string> | undefined, files: Record<string, string>): void {
  const directory = `${ROOT}/node_modules/${name}`
  vfs.seed(`${directory}/package.json`, JSON.stringify({ name, ...exports === undefined ? {} : { exports } }))
  for (const [path, body] of Object.entries(files)) vfs.seed(`${directory}/${path}`, body)
}

it('archives every file of the packages that publish ./assets/* under its unencoded page path', () => {
  const vfs = new MemoryVfs()
  seedPackage(vfs, '@fixture/ui', { './client': './lib/client.js', [PACKAGE_ASSET_EXPORT]: PACKAGE_ASSET_EXPORT_TARGET }, {
    'lib/client.js': '',
    'lib/assets/mark-0123456789ab.svg': '<svg/>',
    'lib/assets/icons/whale@2x-0123456789ab.png': 'png',
  })
  seedPackage(vfs, 'unexported', { '.': './lib/index.js' }, { 'lib/assets/own.svg': '<svg/>' })
  seedPackage(vfs, 'plain', undefined, { 'lib/index.js': '' })
  vfs.seed(`${ROOT}/node_modules/@fixture/stray.txt`, 'not a package')

  const entries = parseTar(packPackageAssets(vfs, ROOT))

  expect(Object.fromEntries(entries.map(entry => [entry.name, new TextDecoder().decode(entry.bytes)]))).toEqual({
    'plugins/@fixture/ui/assets/mark-0123456789ab.svg': '<svg/>',
    'plugins/@fixture/ui/assets/icons/whale@2x-0123456789ab.png': 'png',
  })
  expect(parseTar(packPackageAssets(new MemoryVfs(), ROOT))).toEqual([])
})

it('maps each archived file to a Blob URL under the reference and media type the Client build and route use', async () => {
  const vfs = new MemoryVfs()
  const long = `${'汉'.repeat(10)}-0123456789ab.png`
  seedPackage(vfs, '@fixture/ui', { [PACKAGE_ASSET_EXPORT]: PACKAGE_ASSET_EXPORT_TARGET }, {
    'lib/assets/mark-0123456789ab.svg': '<svg/>',
    'lib/assets/data-0123456789ab.bin': 'raw',
    [`lib/assets/${long}`]: 'png',
    "lib/assets/whale(2x)!'*-0123456789ab.png": 'special',
    ...Object.fromEntries([...PACKAGE_ASSET_MEDIA_TYPES.keys()].map(extension => [`lib/assets/types/a${extension}`, extension])),
  })
  const blobs: Blob[] = []
  const NativeURL = URL
  class StubURL extends NativeURL {
    static override createObjectURL(blob: Blob): string {
      blobs.push(blob)
      return `blob:fixture-${String(blobs.length)}`
    }
  }
  vi.stubGlobal('URL', StubURL)

  const resolve = packageAssetResolver(packPackageAssets(vfs, ROOT))
  const blobOf = (url: string): Blob | undefined => blobs[Number(url.slice('blob:fixture-'.length)) - 1]

  for (const [extension, type] of PACKAGE_ASSET_MEDIA_TYPES) {
    expect(blobOf(resolve(packageAssetReference('@fixture/ui', `types/a${extension}`)))?.type).toBe(type)
  }
  expect(await blobOf(resolve(packageAssetReference('@fixture/ui', "whale(2x)!'*-0123456789ab.png")))?.text()).toBe('special')
  // A name whose encoded reference exceeds a ustar name segment still archives and resolves.
  expect(await blobOf(resolve(packageAssetReference('@fixture/ui', long)))?.text()).toBe('png')
  const svg = resolve('plugins/@fixture/ui/assets/mark-0123456789ab.svg')
  const svgBlob = blobs[Number(svg.slice('blob:fixture-'.length)) - 1]
  expect(svgBlob?.type).toBe('image/svg+xml')
  expect(await svgBlob?.text()).toBe('<svg/>')
  const raw = resolve('plugins/@fixture/ui/assets/data-0123456789ab.bin')
  expect(blobs[Number(raw.slice('blob:fixture-'.length)) - 1]?.type).toBe('')
  expect(resolve('plugins/@fixture/ui/assets/missing.svg')).toBe('plugins/@fixture/ui/assets/missing.svg')
})
