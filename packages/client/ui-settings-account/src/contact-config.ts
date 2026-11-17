/** Public questionnaire options, live on the Host and synced to the browser. */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Questionnaire destination shared by Host and Client; the browser reads it when the user opens the form. */
export interface ContactConfig {
  /** HTTPS questionnaire URL; override for a test form. */
  contactFormUrl: Volatile<string>
  /** Questionnaire source option; empty until Harness is supported by the form. */
  contactSource: Volatile<string>
}
/** Validate public questionnaire options; both fields sync to the browser. */
export const ContactConfigFields = {
  contactFormUrl: z.string().pattern(/^https:\/\/[^/\s]+\//).default('https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1').volatile(),
  contactSource: z.string().default('').volatile(),
}
