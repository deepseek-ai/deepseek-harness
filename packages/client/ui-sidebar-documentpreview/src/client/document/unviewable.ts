/**
 * Known binary container suffixes with no registered renderer. The preview
 * owner shows these the unsupported empty state instead of the plain-text
 * fallback; any renderer registration for a suffix takes precedence because
 * the owner consults this list only when no implementation matches. A suffix
 * belongs here only when its bytes are never readable text — an uncertain
 * suffix stays out and keeps the plain-text fallback.
 */
import { documentFileName, matchedSuffixLength } from './suffix.ts'
const UNVIEWABLE_BINARY_EXTENSIONS: readonly string[] = [
  // video
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v',
  // audio
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus',
  // archives
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar',
  // office documents — `key` stays out: it collides with key/credential files
  // that are readable text, and the uncertain suffix keeps the plain-text fallback
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers',
  // executables and compiled objects
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'class', 'pyc', 'wasm',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // disk images and databases
  'dmg', 'iso', 'img', 'sqlite', 'db',
  // design documents and image formats without a renderer
  'psd', 'ai', 'sketch', 'tiff', 'tif', 'heic', 'heif', 'avif',
]

/**
 * Whether a filename's suffix is a known binary container that no renderer claims.
 * @param path - decoded filename or file path.
 * @returns true when the suffix belongs to the unviewable binary list.
 */
export function unviewableBinaryPath(path: string): boolean {
  return matchedSuffixLength(documentFileName(path), UNVIEWABLE_BINARY_EXTENSIONS) > 0
}
