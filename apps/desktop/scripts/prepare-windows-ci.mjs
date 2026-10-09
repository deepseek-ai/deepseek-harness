/** Prepare public Windows packaging settings and a version for a manual GitHub run. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { desktopBuildVersionPrefix, validateDesktopBuildVersion } from './desktop-build-version.mjs'
import { resolveDesktopPolicyEnvironment } from './desktop-policy-environment.mjs'

/**
 * Validate manual inputs without reading local credentials or querying release storage.
 * @param {NodeJS.ProcessEnv} environment Manual inputs and GitHub run identity.
 * @param {string} productVersion Version declared by the selected checkout.
 * @param {Date} now Time used for the UTC date segment.
 * @returns {{ version: string, settings: string }} Validated version and public dotenv content.
 */
export function windowsCiSettings(environment, productVersion, now = new Date()) {
  const deployment = environment.PACKAGE_DEPLOYMENT
  if (deployment !== 'test' && deployment !== 'production') throw new Error('Select test or production deployment')
  const loginOrigins = (environment.PACKAGE_LOGIN_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (deployment === 'production' && loginOrigins.length > 0) throw new Error('Production must not supply login origins')
  const originKey = deployment === 'test' ? 'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN' : 'DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN'
  const config = deployment === 'test' ? { allowedAuthOrigins: loginOrigins } : {}
  const policy = resolveDesktopPolicyEnvironment({
    DSH_DESKTOP_AUTO_UPDATE_ENV: deployment,
    [originKey]: environment.PACKAGE_POLICY_ORIGIN,
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify(config),
  })
  const requested = environment.PACKAGE_BUILD_VERSION?.trim()
  if (!requested) throw new Error('Build version is required; use auto or a full version')
  let candidate = requested
  if (requested === 'auto') {
    for (const name of ['GITHUB_RUN_NUMBER', 'GITHUB_RUN_ATTEMPT']) {
      if (!/^[1-9]\d*$/u.test(environment[name] ?? '')) throw new Error(`${name} must be a positive integer`)
    }
    const date = now.toISOString().slice(0, 10).replaceAll('-', '')
    candidate = `${desktopBuildVersionPrefix(productVersion)}${date}.${environment.GITHUB_RUN_NUMBER}.${environment.GITHUB_RUN_ATTEMPT}`
  }
  const version = validateDesktopBuildVersion(candidate, productVersion)
  const settings = [
    'DSH_DESKTOP_APP_ID=com.deepseek.harness',
    `DSH_DESKTOP_AUTO_UPDATE_ENV=${deployment}`,
    `${originKey}=${policy.origin}`,
    `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG=${JSON.stringify(config)}`,
  ].join('\n') + '\n'
  return { version, settings }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const appRoot = resolve(import.meta.dirname, '..')
  const product = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'))
  const result = windowsCiSettings(process.env, product.version)
  if (!process.env.GITHUB_OUTPUT || !process.env.GITHUB_STEP_SUMMARY) throw new Error('Run this adapter from GitHub Actions')
  writeFileSync(resolve(appRoot, '.env.windows'), result.settings, { flag: 'wx' })
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\n`)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Windows x64 unsigned installer\n\nVersion: ${result.version}\n\nCommit: ${process.env.GITHUB_SHA}\n\nDeployment: ${process.env.PACKAGE_DEPLOYMENT}\n`)
}
