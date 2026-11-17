/** Validated production destination and credentials; never serialize this value. */
export interface DesktopPurgeConfig {
  readonly zoneId: string
  readonly publicUrl: string
  readonly secretId: string
  readonly secretKey: string
}
