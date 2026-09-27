/** Desktop analytics fields selected by product event owners. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'

/** Event names and their selected product attributes. */
export interface ProductEventMap {
  desktop_app_launch: Record<string, never>
  auth_page_view: Record<string, never>
  auth_page_click: { button_name: 'sign_in' | 'api-key' }
  api_key_save_click: Record<string, never>
  onboarding_page_view: { page_name: OnboardingPage }
  onboarding_page_click: {
    page_name: OnboardingPage
    button_name: 'next' | 'back' | 'skip' | 'charge' | 'later' | 'continue'
    selected_content?: 'office' | 'code' | 'code_office' | 'focus_result' | 'key_detail' | 'full_process'
  }
  onboarding_popup_view: { popup_name: 'skip_charge' | 'skip_setting' }
  onboarding_popup_click: { popup_name: 'skip_charge' | 'skip_setting'; button_name: 'charge' | 'know' | 'enter' | 'setting' | 'close' }
  desktop_upgrade_click: Record<string, never>
  desktop_upgrade_download_result: { is_success: boolean; error_reason?: string }
  desktop_upgrade_install_restart_click: Record<string, never>
  send_button_click: {
    session_id?: SessionId
    model_name?: string
    thinking_effort?: string
    run_mode: 'plan' | 'goal' | 'default'
    msg_type: 'default' | 'steer' | 'queue'
  }
  model_switch: { session_id?: SessionId; switch_from: string; switch_to: string }
  thinking_level_switch: { session_id?: SessionId; switch_from: string; switch_to: string; model_name: string }
  context_compression: { session_id: SessionId; trigger_type: 'auto' | 'manual' }
  branch_session_click: {
    session_id: SessionId
    parent_session_id: SessionId
    parent_message_id?: MessageId
    click_position: 'footer' | 'sidebar'
  }
  sidebar_menu_click: { menu_name: 'plugin' | 'cron' }
  plugin_toggle: { plugin_name: string; plugin_type: 'plugin' | 'bundle'; is_enabled: boolean; is_builtin: boolean }
  plugin_add_button_click: Record<string, never>
  plugin_install_click: { input_value: string }
  install_plugin_result: {
    input_value: string
    is_success: boolean
    error_reason?: string
    duration: number
    plugin_name?: string
  }
  confirm_uninstall_plugin: { plugin_name: string }
}

/** Public page names independent of internal onboarding state names. */
export type OnboardingPage = 'onboarding_welcome' | 'onboarding_recharge' | 'onboarding_use_case' | 'onboarding_process'

/** Correlated event name and attributes for the authenticated analytics RPC. */
export type ProductEvent = {
  [K in keyof ProductEventMap]: { eventName: K; attributes: ProductEventMap[K]; timestamp: number }
}[keyof ProductEventMap]

/** Callback passed into presentation components; omitted when collection is disabled. */
export type TrackProductEvent = <K extends keyof ProductEventMap>(name: K, attributes: ProductEventMap[K]) => void
