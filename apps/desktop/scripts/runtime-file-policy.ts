/** Desktop-only omissions from already installed production npm packages. */

/**
 * Identify build and diagnostic files omitted from the immutable Desktop runtime.
 * Unrecognized assets and target runtime binaries are retained. Paths name the copied
 * node_modules tree, including nested package containers.
 * @param path - Path relative to the production node_modules directory.
 * @param target - Platform and architecture of the bundled Node executable.
 * @returns Omission reason, or undefined when the entry must be copied.
 */
export function desktopRuntimeFileExclusion(
  path: string, target: { platform: NodeJS.Platform; arch: string },
): string | undefined {
  const parts = path.split(/[\\/]/u)
  if (parts.some(part => ['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json'].includes(part))) {
    return 'package-manager metadata'
  }
  const file = parts.at(-1) ?? ''
  if (/\.(?:[cm]?[jt]s|css)\.map$/u.test(file)) return 'source map'
  if (/\.d\.[cm]?ts$/u.test(file)) return 'TypeScript declaration'
  if (/\.tsbuildinfo$/u.test(file)) return 'TypeScript build cache'
  const packageParts = parts.slice(parts.lastIndexOf('node_modules') + 1)
  const nameParts = packageParts[0]?.startsWith('@') ? 2 : 1
  const name = packageParts.slice(0, nameParts).join('/')
  const entry = packageParts.slice(nameParts).join('/')
  if (name === 'fs-ext' && /^build\/(?:Release|Debug)\/(?:obj(?:\/|$)|fs_ext\.(?:exp|lib|pdb|iobj|ipdb)$)/u.test(entry)) {
    return 'fs-ext compiler output'
  }
  if (name === 'fs-ext' && /^build\/(?:binding\.sln|config\.gypi|fs_ext\.vcxproj(?:\.filters)?)$/u.test(entry)) {
    return 'fs-ext build configuration'
  }
  if (name === '@mixmark-io/domino' && (entry === 'test' || entry.startsWith('test/'))) return 'Domino test fixtures'
  if (name === 'node-pty' && entry.startsWith('prebuilds/')) {
    const platform = packageParts[nameParts + 1]
    if (platform !== undefined && platform !== `${target.platform}-${target.arch}`) return 'node-pty other platform'
    if (file.endsWith('.pdb')) return 'node-pty debug symbols'
  }
  if (name === '@koromix/koffi-win32-x64' && entry === 'win32_x64/koffi.lib') return 'Koffi import library'
  return undefined
}
