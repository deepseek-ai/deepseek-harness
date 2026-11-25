/** The official connectors a plugin card can install, and the shipped bundle that adds their Plugins tab. */

/** One official connector bundle, as the catalog and its card name it before the profile holds it. */
export interface Connector {
  /** Package and bundle name; every DSH release publishes it to npm at the DSH version. */
  readonly name: string
  /**
   * `meta.title` of the package's own `locale/en.json` and `locale/zh.json`, keyed by the file's language id: the app's
   * name, which the skill's catalog entry also uses in English.
   */
  readonly title: { readonly en: string; readonly zh: string }
  /** `meta.description` of the package's own `locale/en.json` and `locale/zh.json`, keyed by the file's language id. */
  readonly description: { readonly en: string; readonly zh: string }
}

/**
 * Every official connector; the skill's catalog entry names their apps in this list's order. The installation does not
 * ship them, so the catalog carries their English text and the card of an uninstalled one their English and Chinese
 * text; a test compares each entry with its package's own name and locale files.
 */
export const CONNECTORS: readonly Connector[] = [
  { name: '@deepseek-ai/dsh-feishu', title: { en: 'Feishu', zh: '飞书' }, description: {
    en: 'Use Feishu documents, messages, and other authorized features in conversations.',
    zh: '在对话中使用飞书文档、消息及其他已授权的功能。',
  } },
  { name: '@deepseek-ai/dsh-wecom', title: { en: 'WeCom', zh: '企业微信' }, description: {
    en: 'Use WeCom docs, calendar, meetings, to-dos, and messages in conversations.',
    zh: '在对话中使用企业微信的文档、日程、会议、待办和消息。',
  } },
  { name: '@deepseek-ai/dsh-dingtalk', title: { en: 'DingTalk', zh: '钉钉' }, description: {
    en: 'Use DingTalk calendar, to-dos, docs, AI tables, group chats, and contacts in conversations.',
    zh: '在对话中使用钉钉的日程、待办、文档、AI 表格、群聊和通讯录。',
  } },
  { name: '@deepseek-ai/dsh-tencent-meeting', title: { en: 'Tencent Meeting', zh: '腾讯会议' }, description: {
    en: 'Use Tencent Meeting meetings, recordings, minutes, and meeting reports in conversations.',
    zh: '在对话中使用腾讯会议的会议、录制、纪要和会议报告。',
  } },
  { name: '@deepseek-ai/dsh-notion', title: { en: 'Notion', zh: 'Notion' }, description: {
    en: 'Use Notion pages, databases, and other authorized content in conversations.',
    zh: '在对话中使用 Notion 页面、数据库及其他已授权的内容。',
  } },
  { name: '@deepseek-ai/dsh-tencent-docs', title: { en: 'Tencent Docs', zh: '腾讯文档' }, description: {
    en: 'Use the Tencent Docs content you can access in conversations.',
    zh: '在对话中使用你有权限的腾讯文档内容。',
  } },
  { name: '@deepseek-ai/dsh-linear', title: { en: 'Linear', zh: 'Linear' }, description: {
    en: 'Use Linear issues, projects, and comments in conversations.',
    zh: '在对话中使用 Linear 的议题、项目与评论。',
  } },
]

/** Shipped optional bundle that adds the Connectors tab to Plugins; connectors run without it. */
export const CONNECTORS_TAB_BUNDLE = '@deepseek-ai/dsh-client-ui-connectors'
