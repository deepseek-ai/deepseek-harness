/** Windows operation scopes and shared Computer Use instructions. */
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'

const PLATFORM_GUIDANCE = 'Windows: accessibility, simulated mouse input, and simulated keyboard input are available only at window level.'

/** Platform guidance followed by the shared application and window instructions. */
export const GUIDANCE = `${PLATFORM_GUIDANCE}\n\n${COMMON_GUIDANCE}`
