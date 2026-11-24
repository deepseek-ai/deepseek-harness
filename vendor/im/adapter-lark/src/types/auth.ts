/** Retained Feishu OpenAPI declarations from satori@662c3daff128b4b610ebbc393bac388679e60010. */
import { type BaseResponse, Internal } from '../internal.ts'

declare module '../internal.ts' {
  interface Internal {
    auth: Auth.Methods
  }
}

export namespace Auth {
  export interface Methods {
    /**
     * 自建应用获取 tenant_access_token
     * @see https://open.feishu.cn/document/ukTMukTMukTM/ukDNz4SO0MjL5QzM/auth-v3/auth/tenant_access_token_internal
     */
    tenantAccessTokenInternal(body: TenantAccessTokenInternalRequest): Promise<Auth.TenantAccessTokenInternalResponse>
    /**
     * 自建应用获取 app_access_token
     * @see https://open.feishu.cn/document/ukTMukTMukTM/ukDNz4SO0MjL5QzM/auth-v3/auth/app_access_token_internal
     */
    appAccessTokenInternal(body: AppAccessTokenInternalRequest): Promise<Auth.AppAccessTokenInternalResponse>
    /**
     * 重新获取 app_ticket
     * @see https://open.feishu.cn/document/ukTMukTMukTM/ukDNz4SO0MjL5QzM/auth-v3/auth/app_ticket_resend
     */
    appTicketResend(body: AppTicketResendRequest): Promise<void>
    /**
     * 商店应用获取 app_access_token
     * @see https://open.feishu.cn/document/ukTMukTMukTM/ukDNz4SO0MjL5QzM/auth-v3/auth/app_access_token
     */
    appAccessToken(body: AppAccessTokenRequest): Promise<Auth.AppAccessTokenResponse>
    /**
     * 商店应用获取 tenant_access_token
     * @see https://open.feishu.cn/document/ukTMukTMukTM/ukDNz4SO0MjL5QzM/auth-v3/auth/tenant_access_token
     */
    tenantAccessToken(body: TenantAccessTokenRequest): Promise<Auth.TenantAccessTokenResponse>
  }

  export interface TenantAccessTokenInternalRequest {
    /** 应用唯一标识，创建应用后获得 */
    app_id: string
    /** 应用秘钥，创建应用后获得 */
    app_secret: string
  }

  export interface TenantAccessTokenInternalResponse extends BaseResponse {
    /** 访问 token */
    tenant_access_token?: string
    /** app_access_token 过期时间 */
    expire?: number
  }

  export interface AppAccessTokenInternalRequest {
    /** 应用唯一标识，创建应用后获得 */
    app_id: string
    /** 应用秘钥，创建应用后获得 */
    app_secret: string
  }

  export interface AppAccessTokenInternalResponse extends BaseResponse {
    /** 访问 token */
    app_access_token?: string
    /** app_access_token 过期时间 */
    expire?: number
  }

  export interface AppTicketResendRequest {
    /** 应用唯一标识，创建应用后获得 */
    app_id: string
    /** 应用秘钥，创建应用后获得 */
    app_secret: string
  }

  export interface AppAccessTokenRequest {
    /** 应用唯一标识，创建应用后获得 */
    app_id: string
    /** 应用秘钥，创建应用后获得 */
    app_secret: string
    /** 平台定时推送给应用的临时凭证，通过事件监听机制获得 */
    app_ticket: string
  }

  export interface AppAccessTokenResponse extends BaseResponse {
    /** 访问 token */
    app_access_token?: string
    /** app_access_token 过期时间 */
    expire?: number
  }

  export interface TenantAccessTokenRequest {
    /** 应用唯一标识，创建应用 */
    app_access_token: string
    /** 应用秘钥，创建应用后获得 */
    tenant_key: string
  }

  export interface TenantAccessTokenResponse extends BaseResponse {
    /** 访问 token */
    tenant_access_token?: string
    /** app_access_token 过期时间 */
    expire?: number
  }
}

Internal.define({
  '/auth/v3/tenant_access_token/internal': {
    POST: { name: 'auth.tenantAccessTokenInternal', type: 'raw-json' },
  },
  '/auth/v3/app_access_token/internal': {
    POST: { name: 'auth.appAccessTokenInternal', type: 'raw-json' },
  },
  '/auth/v3/app_ticket/resend': {
    POST: 'auth.appTicketResend',
  },
  '/auth/v3/app_access_token': {
    POST: { name: 'auth.appAccessToken', type: 'raw-json' },
  },
  '/auth/v3/tenant_access_token': {
    POST: { name: 'auth.tenantAccessToken', type: 'raw-json' },
  },
})
