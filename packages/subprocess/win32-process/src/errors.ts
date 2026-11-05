import { HarnessError } from '@deepseek-ai/dsh-error'

/** Code of every {@link Win32Error}; the failing API and its numeric code stay in `api`, `win32Code`, and `message`. */
export const WIN32_ERROR = 'WIN32_ERROR'

/** Win32 call failure with the exact API name and error code. */
export class Win32Error extends HarnessError {
  /** Win32 function whose checked result failed. */
  readonly api: string
  /** Exact GetLastError value or direct Win32 API error code. */
  readonly win32Code: number

  /**
   * @param api - Win32 function whose checked result failed.
   * @param win32Code - exact GetLastError value or direct API error code.
   * @param detail - optional subject, such as the path the call targeted.
   */
  constructor(api: string, win32Code: number, detail?: string) {
    super(`${api} failed (Win32 ${win32Code})${detail === undefined ? '' : `: ${detail}`}`, WIN32_ERROR)
    this.name = 'Win32Error'
    this.api = api
    this.win32Code = win32Code
  }
}
