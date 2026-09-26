/** Which registries an operation asks, in order, and what a failed attempt could not reach: pure, table-driven. */

import { describe, expect, it } from 'vitest'
import { parseInstallSpec } from '../src/install-spec.ts'
import { attributeFailure, normalizeRegistry, OFFICIAL_NPM_REGISTRY, registryPlan, REGISTRY_URL } from '../src/registry.ts'

const MIRROR = 'https://registry.npmmirror.com/'
const CORP = 'https://npm.corp.example/'

describe('normalizeRegistry', () => {
  it('parses an http(s) URL into pnpm\'s comparison form: lower-case host, trailing slash', () => {
    expect(normalizeRegistry('https://REGISTRY.npmmirror.com')).toBe(MIRROR)
    expect(normalizeRegistry('http://npm.corp.example:4873/prefix')).toBe('http://npm.corp.example:4873/prefix/')
    expect(normalizeRegistry(MIRROR)).toBe(MIRROR)
  })

  it('refuses anything but an http(s) URL, as REGISTRY_URL does', () => {
    for (const url of ['registry.npmmirror.com', 'ftp://x/', 'file:///tmp', '', 'https://']) {
      expect(() => normalizeRegistry(url), url).toThrow(/http\(s\) URL/)
      expect(REGISTRY_URL.test(url), url).toBe(false)
    }
    expect(REGISTRY_URL.test(MIRROR)).toBe(true)
  })
})

describe('registryPlan', () => {
  /** The shipped configuration on a machine whose pnpm names npm's own registry. */
  const shipped = { registry: null, fallbackRegistries: [MIRROR], resolved: OFFICIAL_NPM_REGISTRY }

  it('asks pnpm\'s own registry first, then the fallbacks, when pnpm\'s own is the public one', () => {
    expect(registryPlan(undefined, shipped)).toEqual([null, MIRROR])
    expect(registryPlan(null, shipped)).toEqual([null, MIRROR])
  })

  it('moves a requested registry to the front when it is one of the configured set', () => {
    expect(registryPlan(MIRROR, shipped)).toEqual([MIRROR, null])
    expect(registryPlan('https://REGISTRY.npmmirror.com', shipped)).toEqual([MIRROR, null])
    expect(registryPlan(null, { registry: MIRROR, fallbackRegistries: [], resolved: OFFICIAL_NPM_REGISTRY })).toEqual([null])
  })

  it('asks a registry outside the configured set alone, never followed by a public one', () => {
    expect(registryPlan(CORP, shipped)).toEqual([CORP])
    expect(registryPlan(undefined, { registry: CORP, fallbackRegistries: [], resolved: OFFICIAL_NPM_REGISTRY })).toEqual([CORP])
    expect(registryPlan(undefined, { registry: CORP, fallbackRegistries: [MIRROR], resolved: OFFICIAL_NPM_REGISTRY }))
      .toEqual([CORP, MIRROR])
  })

  it('keeps pnpm\'s own registry alone when it names a private one, and never falls back into it', () => {
    const corporate = { ...shipped, resolved: CORP }
    expect(registryPlan(undefined, corporate)).toEqual([null])
    expect(registryPlan(null, corporate)).toEqual([null])
    // The same registry typed by URL is the private one too.
    expect(registryPlan(CORP, corporate)).toEqual([CORP])
    // A public mirror picked over a private default is asked alone: the private registry is not a fallback for it.
    expect(registryPlan(MIRROR, corporate)).toEqual([MIRROR])
  })

  it('keeps pnpm\'s own registry alone while what it names is unknown', () => {
    const unknown = { ...shipped, resolved: null }
    expect(registryPlan(undefined, unknown)).toEqual([null])
    expect(registryPlan(MIRROR, unknown)).toEqual([MIRROR])
  })

  it('asks a registry once when pnpm\'s own configuration already names a fallback', () => {
    const mirrored = { ...shipped, resolved: MIRROR }
    expect(registryPlan(undefined, mirrored)).toEqual([null])
    expect(registryPlan(MIRROR, mirrored)).toEqual([MIRROR])
    expect(registryPlan(undefined, { registry: null, fallbackRegistries: [MIRROR, CORP], resolved: MIRROR })).toEqual([null, CORP])
  })

  it('lists each registry once', () => {
    expect(registryPlan(undefined, { registry: MIRROR, fallbackRegistries: [MIRROR, CORP], resolved: OFFICIAL_NPM_REGISTRY }))
      .toEqual([MIRROR, CORP])
  })
})

describe('attributeFailure', () => {
  const name = parseInstallSpec('dsh-x')
  const git = parseInstallSpec('github:acme/dsh-x')
  const tarball = parseInstallSpec('https://cdn.example.com/dsh-x-1.0.0.tgz')
  const registryLog = 'ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/dsh-x: getaddrinfo ENOTFOUND registry.npmjs.org'

  it('lays a failure another registry can change at the registry: unreachable, or a copy it lacks', () => {
    for (const kind of ['network', 'timeout', 'not-found', 'no-matching-version'] as const) {
      expect(attributeFailure(kind, registryLog, name), kind).toBe('registry')
    }
  })

  it('lays a failure no registry would change at neither', () => {
    for (const kind of ['build-blocked', 'disk-full', 'permission', 'integrity', 'pnpm-missing', 'unknown'] as const) {
      expect(attributeFailure(kind, registryLog, name), kind).toBe('other')
    }
  })

  it('lays a failure whose error line names the host a git or tarball spec is fetched from at that host', () => {
    expect(attributeFailure('network', 'fatal: unable to access \'https://github.com/acme/dsh-x/\': Could not resolve host: github.com', git)).toBe('spec-host')
    expect(attributeFailure('network', 'ssh: Could not resolve hostname GITHUB.COM: nodename nor servname provided', git)).toBe('spec-host')
    expect(attributeFailure('network', 'ERR_PNPM_FETCH_502  GET https://cdn.example.com/dsh-x-1.0.0.tgz: Bad Gateway', tarball)).toBe('spec-host')
    // The same specs' dependencies still come from the registry.
    expect(attributeFailure('network', registryLog, git)).toBe('registry')
    expect(attributeFailure('network', registryLog, tarball)).toBe('registry')
    expect(attributeFailure('not-found', 'ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/left-pad: Not Found - 404', git)).toBe('registry')
  })

  it('reads the host only off error lines, not off a warning that links to it', () => {
    const log = [
      'WARN  deprecated left-pad@1.0.0: see https://github.com/acme/dsh-x#readme',
      'ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/left-pad: ETIMEDOUT',
    ].join('\n')
    expect(attributeFailure('network', log, git)).toBe('registry')
  })

  it('reads a failure that names no host as the registry\'s', () => {
    expect(attributeFailure('network', 'ECONNRESET', git)).toBe('registry')
    expect(attributeFailure('network', 'socket hang up', name)).toBe('registry')
  })
})
