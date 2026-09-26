/**
 * Gateway infrastructure failure codes merged into the shared Remote failure
 * vocabulary. Face-neutral: the Host face and the Client face each import this
 * module so both programs see the same map entries.
 */

/** Wire details every Gateway infrastructure failure carries. */
export interface TypertGatewayFaultDetails {
  /** Canonical `<namespace>/<method>` endpoint. */
  readonly endpoint: string
  /** Affected wire field when the failure is field-specific. */
  readonly field?: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'gateway/ambiguous-endpoint': TypertGatewayFaultDetails
    'gateway/arguments-invalid': TypertGatewayFaultDetails
    'gateway/binding-invalid': TypertGatewayFaultDetails
    'gateway/context-failed': TypertGatewayFaultDetails
    'gateway/context-not-found': TypertGatewayFaultDetails
    'gateway/context-unavailable': TypertGatewayFaultDetails
    'gateway/definition-unavailable': TypertGatewayFaultDetails
    'gateway/input-invalid': TypertGatewayFaultDetails
    'gateway/invocation-unavailable': TypertGatewayFaultDetails
    'gateway/lookup-failed': TypertGatewayFaultDetails
    'gateway/lookup-not-found': TypertGatewayFaultDetails
    'gateway/lookup-unavailable': TypertGatewayFaultDetails
    'gateway/method-unavailable': TypertGatewayFaultDetails
    'gateway/protocol': TypertGatewayFaultDetails
    'gateway/provider-mismatch': TypertGatewayFaultDetails
    'gateway/result-invalid': TypertGatewayFaultDetails
    'gateway/service-unavailable': TypertGatewayFaultDetails
    'gateway/signature-invalid': TypertGatewayFaultDetails
    'gateway/uplink-overflow': TypertGatewayFaultDetails
  }
}
