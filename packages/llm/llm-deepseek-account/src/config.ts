/** Account providers expose protocol settings without an API-key reference. */
import { Config as ProtocolConfig } from '@deepseek-ai/dsh-llm-deepseek'

/** Account route configuration; authentication comes exclusively from the account service. */
export type Config = ProtocolConfig
export const Config = ProtocolConfig
