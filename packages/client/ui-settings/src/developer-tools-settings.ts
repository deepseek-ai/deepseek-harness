/** Shared Web and desktop developer-tool preference stored by the Host. */
import z from '@deepseek-ai/schemastery'

/** Namespace for developer UI and HTML preview capabilities. */
export const DEVELOPER_TOOLS_NAMESPACE = 'ui-settings'

/** Persisted developer-tool choice. */
export interface DeveloperToolsSettings {
  /** Enable diagnostic views, preset selection, change summaries and scripted HTML previews. */
  enabled: boolean
}

/** New installations and missing values enable the full interface. */
export const DeveloperToolsSettingsFields = {
  enabled: z.boolean().default(true),
}

/** Schema for shared configuration values. */
export const DeveloperToolsSettingsSchema = z.object(DeveloperToolsSettingsFields)
