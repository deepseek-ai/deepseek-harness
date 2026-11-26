/** Native addon build support for Desktop packaging: target build environment and object-file architecture checks. */
/** Check the object header against the requested platform and CPU. */
export function matchingArchitecture(bytes: Buffer, target: { platform: string; arch: string }): boolean
/** The `vcvarsall.bat` argument that targets `arch` from a `host` build machine. */
export function vcvarsallTarget(host: string, arch: string): string
/** Read the environment `set` printed after the build environment marker; throws when the marker is missing. */
export function parseDeveloperEnvironment(output: string): Record<string, string>
/** The build environment for a target: on Windows the MSVC developer environment; always with `DSH_NODE_API_HEADERS`. */
export function nativeBuildEnvironment(arch: string, environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
