/** Approved packaging workflows and machine publication targets. */
import { z } from 'zod'

const targetSchema = z.enum(['mac-arm64', 'mac-x64', 'win-x64'])

/** Accepted workflow paths per target, including builds retained under an earlier workflow filename. */
export const desktopPackageWorkflows: Readonly<Record<z.infer<typeof targetSchema>, readonly string[]>> = {
  'mac-arm64': ['.github/workflows/desktop-package-macos-arm64.yml', '.github/workflows/macos-package.yml'],
  'mac-x64': ['.github/workflows/desktop-package-macos-x64.yml', '.github/workflows/macos-intel-package.yml'],
  'win-x64': ['.github/workflows/desktop-package-windows-x64.yml', '.github/workflows/windows-package.yml'],
}

/** Machine labels are unique; a scalar target is shorthand for a one-element target list. */
export const desktopPublishRunnersSchema = z.record(z.string(), z.object({
  label: z.string().regex(/^dsh-[a-z0-9-]+$/u),
  target: z.union([targetSchema, z.array(targetSchema).min(1)])
    .transform(value => typeof value === 'string' ? [value] : value),
}))
