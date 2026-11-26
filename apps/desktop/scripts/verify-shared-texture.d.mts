/** Verify Desktop's shared-texture hop and ingress addons on macOS and Windows. */
export function verifySharedTextureAddons(appDir: string, target: { platform: string; arch: string }): Promise<void>

/**
 * Addons required by Desktop's texture transport.
 * @param platform - Electron execution platform.
 * @returns Addon basenames without `.node`; empty on unsupported platforms.
 */
export function sharedTextureAddonNames(platform: string): readonly string[]
