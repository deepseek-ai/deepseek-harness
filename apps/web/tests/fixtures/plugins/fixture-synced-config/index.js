/** Host face of the synced-configuration fixture: the only Config schema, with an ordinary field and two volatile fields. */
import z from '@deepseek-ai/schemastery'

/** Ordinary `cacheDir` stays on the Host; volatile `greeting` and `account` reach the browser without `account.token`. */
export const Config = z.object({
  cacheDir: z.string().required(),
  greeting: z.string().required().volatile(),
  account: z.object({
    label: z.string().required(),
    token: z.string().role('secret').required(),
  }).volatile(),
})

/** Nothing to mount on the Host. */
export function apply() {}
