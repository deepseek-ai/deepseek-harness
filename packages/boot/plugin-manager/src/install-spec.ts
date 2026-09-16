/**
 * Reading an install spec before pnpm sees it: which of pnpm's spec forms it
 * takes, and for a registry name whether it is one the registry can accept.
 * @module @deepseek-ai/dsh-plugin-manager/install-spec
 */

import { isAbsolute } from 'node:path'

/** One spec read into its form and the parts an inspection needs. */
export type ParsedInstallSpec =
  | { readonly kind: 'registry'; readonly spec: string; readonly name: string; readonly range?: string }
  | { readonly kind: 'path'; readonly spec: string; readonly path: string }
  | { readonly kind: 'tarball'; readonly spec: string; readonly path?: string }
  | { readonly kind: 'git'; readonly spec: string }

/** The forms pnpm resolves through a git host: a host shorthand, a git URL, or a hosted repository URL. */
const GIT_SHORTHAND = /^(?:github|gitlab|bitbucket|gist):/i
const GIT_URL = /^git(?:\+[a-z]+)?:\/\/|^git@[^:]+:/i
const HOSTED_REPOSITORY_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i
/** A tarball, on disk or over HTTP. */
const TARBALL_SPEC = /\.(?:tgz|tar\.gz)(?:#.*)?$/i
/** An npm package name: lowercase URL-safe segments, an optional scope, no leading dot or underscore. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const PACKAGE_NAME_MAX_LENGTH = 214

/** A spec neither pnpm nor the registry would take; `reason` is what the person reads. */
export class InvalidInstallSpecError extends Error {
  /**
   * @param spec - the spec as typed, trimmed.
   * @param reason - why it is refused, as one sentence.
   */
  constructor(readonly spec: string, readonly reason: string) {
    super(`plugin-manager: ${reason}: ${spec}`)
    this.name = 'InvalidInstallSpecError'
  }
}

function invalid(spec: string, reason: string): InvalidInstallSpecError {
  return new InvalidInstallSpecError(spec, reason)
}

/**
 * Read a spec into its form. A path must be absolute: the Host's working
 * directory means nothing to the person typing into a browser, and a
 * relative path resolved against the profile would point inside it.
 * @param raw - the spec as typed.
 * @returns the parsed spec.
 * @throws {InvalidInstallSpecError} for an empty spec, a relative path, a name the
 * registry would refuse, or a URL that is neither a git host nor a tarball.
 */
export function parseInstallSpec(raw: string): ParsedInstallSpec {
  const spec = raw.trim()
  if (spec === '') throw invalid(spec, 'the package spec must not be empty')
  const path = spec.replace(/^(?:file|link):/, '')
  if (path !== spec || isAbsolute(path)) {
    if (!isAbsolute(path)) throw invalid(spec, 'a local path must be absolute')
    return TARBALL_SPEC.test(path) ? { kind: 'tarball', spec, path } : { kind: 'path', spec, path }
  }
  if (/^\.{1,2}(?:[\\/]|$)/.test(spec)) throw invalid(spec, 'a local path must be absolute')
  const git = GIT_SHORTHAND.test(spec) || GIT_URL.test(spec) || HOSTED_REPOSITORY_URL.test(spec)
  if (git && !TARBALL_SPEC.test(spec)) return { kind: 'git', spec }
  if (/^https?:\/\//i.test(spec)) {
    if (TARBALL_SPEC.test(spec)) return { kind: 'tarball', spec }
    throw invalid(spec, 'a URL must point at a git repository or a tarball')
  }
  const at = spec.indexOf('@', 1)
  const name = at === -1 ? spec : spec.slice(0, at)
  const range = at === -1 ? undefined : spec.slice(at + 1)
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) {
    throw invalid(spec, 'not a package name the registry accepts')
  }
  if (range === '') throw invalid(spec, 'a version after @ must not be empty')
  return range === undefined ? { kind: 'registry', spec, name } : { kind: 'registry', spec, name, range }
}
