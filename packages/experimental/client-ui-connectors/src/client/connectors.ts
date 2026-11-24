/** The official connectors the Connectors tab offers, in display order. */

/** Dictionary prefix of one connector's title and description: its package name without the scope prefix. */
export type ConnectorId = 'feishu' | 'wecom' | 'dingtalk' | 'tencent-meeting' | 'notion' | 'tencent-docs' | 'linear'

/** One official connector bundle. */
export interface Connector {
  /** Dictionary prefix of its title and description. */
  readonly id: ConnectorId
  /** npm package name of its bundle, released with DSH at the same version. */
  readonly packageName: string
}

/** Every official connector, in display order. */
export const CONNECTORS: readonly Connector[] = [
  { id: 'feishu', packageName: '@deepseek-ai/dsh-feishu' },
  { id: 'wecom', packageName: '@deepseek-ai/dsh-wecom' },
  { id: 'dingtalk', packageName: '@deepseek-ai/dsh-dingtalk' },
  { id: 'tencent-meeting', packageName: '@deepseek-ai/dsh-tencent-meeting' },
  { id: 'notion', packageName: '@deepseek-ai/dsh-notion' },
  { id: 'tencent-docs', packageName: '@deepseek-ai/dsh-tencent-docs' },
  { id: 'linear', packageName: '@deepseek-ai/dsh-linear' },
]
