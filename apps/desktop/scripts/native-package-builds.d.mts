/** Build and verify native addons that runtime packages compile from shipped sources under `package.json` `dsh.native`, with the target build environment and object-file architecture checks. */
/** One package's validated `dsh.native` declaration. */
export interface NativePackageBuild { name: string; root: string; build: string; addons: string[] }
/** Check the object header against the requested platform and CPU. */
export function matchingArchitecture(bytes: Buffer, target: { platform: string; arch: string }): boolean
/** The validated `dsh.native` declaration of one package directory, or undefined when it declares none or is not a DeepSeek Harness package. */
export function nativePackageBuildAt(root: string): NativePackageBuild | undefined
/** Every installed package under a runtime root that declares `dsh.native`, including nested `node_modules`. */
export function nativePackageBuilds(runtimeRoot: string): NativePackageBuild[]
/** The `vcvarsall.bat` argument that targets `arch` from a `host` build machine. */
export function vcvarsallTarget(host: string, arch: string): string
/** Read the environment `set` printed after the build environment marker; throws when the marker is missing. */
export function parseDeveloperEnvironment(output: string): Record<string, string>
/** The build environment for a target: on Windows the MSVC developer environment; always with `DSH_NODE_API_HEADERS`. */
export function nativeBuildEnvironment(arch: string, environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
/** Run one package's declared build for a target architecture; throws when it fails. */
export function buildNativePackage(declaration: Pick<NativePackageBuild, 'name' | 'root' | 'build'>, arch: string, environment?: NodeJS.ProcessEnv): void
/** Build every declared addon in the runtime for a target architecture and return the built package names. */
export function buildNativePackages(runtimeRoot: string, arch: string): string[]
/** Require every declared addon of the target, its build record, its hash, and its architecture. */
export function verifyNativePackages(runtimeRoot: string, target: { platform: string; arch: string }): void
