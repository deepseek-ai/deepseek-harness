import type { ReactNode } from 'react'
import clsx from 'clsx'
import { CodeFileIcon } from './CodeFileIcon.tsx'
import {
  classifyCodeFileType, isCodeFileType, type CodeFileType, type FileTypeProjectContext,
} from './code-file-types.ts'
import type { IconProps } from './icons/props.ts'
import css from './FileTypeIcon.module.css'

/** File categories with distinct 28px glyphs. */
export type FileType =
  | CodeFileType
  | 'code'
  | 'excel'
  | 'folder'
  | 'html'
  | 'image'
  | 'markdown'
  | 'other'
  | 'pdf'
  | 'ppt'
  | 'video'
  | 'word'

/** Compatibility name for consumers that pass an already resolved category. */
export type FileTypeKind = FileType

type ClassifiedFileType = Exclude<FileType, 'folder'>
type TraditionalFileType = Exclude<FileType, CodeFileType>

export type { CodeFileType, FileTypeProjectContext } from './code-file-types.ts'

/** Props for {@link FileTypeIcon}: either a path to classify or an already resolved kind. */
export type FileTypeIconProps = IconProps & (
  | {
    /** File path or name to classify. */
    readonly path: string
    /** Optional project-file snapshot for context-sensitive code icons such as Flutter. */
    readonly context?: FileTypeProjectContext | undefined
  }
  | {
    /** Explicit category for callers that already resolved the file type. */
    readonly kind: FileTypeKind
  }
)

const EXTENSION_TYPES: Readonly<Record<string, ClassifiedFileType>> = {
  scss: 'code',
  sass: 'code',
  less: 'code',
  vue: 'code',
  svelte: 'code',
  astro: 'code',
  bat: 'code',
  cmd: 'code',
  csv: 'code',
  tsv: 'code',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  tif: 'image',
  tiff: 'image',
  heic: 'image',
  heif: 'image',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  pdf: 'pdf',
  ppt: 'ppt',
  pptx: 'ppt',
  key: 'ppt',
  mp4: 'video',
  mov: 'video',
  m4v: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  mpg: 'video',
  mpeg: 'video',
  doc: 'word',
  docx: 'word',
  rtf: 'word',
  odt: 'word',
  pages: 'word',
  xls: 'excel',
  xlsx: 'excel',
  xlsm: 'excel',
  numbers: 'excel',
}

const NAME_TYPES: Readonly<Record<string, ClassifiedFileType>> = {
  changelog: 'markdown',
  contributing: 'markdown',
  readme: 'markdown',
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * Extract the final suffix from a file path without changing its case.
 * A leading dot starts a suffix, while a missing or trailing dot returns an empty string.
 * @param path - File path or basename using either path separator.
 * @returns The characters after the basename's final dot.
 */
export function fileExtension(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1)
}

/**
 * Classify a file path or name for file-card presentation.
 * Matching is case-insensitive and applies code filename rules before extension rules;
 * unknown names fall back to `other`.
 * @param path - File path or basename using either path separator.
 * @param context - Optional project files used by context-sensitive code mappings.
 * @returns The file's closed presentation category.
 */
export function classifyFileType(
  path: string,
  context?: FileTypeProjectContext,
): ClassifiedFileType {
  const name = basename(path).toLowerCase()
  const extension = fileExtension(name).toLowerCase()
  return classifyCodeFileType(name, extension, context)
    ?? NAME_TYPES[name]
    ?? EXTENSION_TYPES[extension]
    ?? 'other'
}

const FILE_BODY = 'M8.48924 28H19.5108C21.6479 28 22.7165 28 23.5594 27.6509C24.6833 27.1853 25.5762 26.2924 26.0417 25.1685C26.3909 24.3256 26.3909 23.257 26.3909 21.1199V8.79443C26.3909 8.32877 26.3909 8.09593 26.3471 7.87507C26.2887 7.58058 26.173 7.30042 26.0067 7.05048C25.882 6.86303 25.7177 6.69799 25.3893 6.36792L20.0611 1.01354C19.7304 0.681235 19.5651 0.515081 19.3769 0.38885C19.126 0.220541 18.8443 0.103463 18.5481 0.0443412C18.3259 0 18.0915 0 17.6226 0H8.48924C6.35209 0 5.28351 0 4.4406 0.349145C3.31672 0.814671 2.4238 1.70759 1.95828 2.83147C1.60913 3.67438 1.60913 4.74296 1.60913 6.88011V21.1199C1.60913 23.257 1.60913 24.3256 1.95828 25.1685C2.4238 26.2924 3.31672 27.1853 4.4406 27.6509C5.28351 28 6.35209 28 8.48924 28Z'
const FILE_FOLD = 'M26.3909 7.37445L19.0525 0V3.77445C19.0525 4.89271 19.0525 5.45184 19.2352 5.89289C19.4788 6.48096 19.946 6.94818 20.5341 7.19176C20.9751 7.37445 21.5342 7.37445 22.6525 7.37445H26.3909Z'
const FILE_MARK_TRANSFORM = 'translate(14 16) scale(1.12) translate(-14 -16)'
const LARGE_FILE_MARK_TRANSFORM = 'translate(14 16) scale(1.22) translate(-14 -16)'
const FOLDER_MARK_TRANSFORM = 'translate(14 13.0693) scale(1.12) translate(-14 -13.0693)'

function FileGlyph({
  size, className, children, markTransform = FILE_MARK_TRANSFORM, muted = false,
}: IconProps & { children?: ReactNode; markTransform?: string; muted?: boolean }): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d={FILE_BODY} fill="currentColor" />
      {muted
        ? <path d={FILE_FOLD} fill="var(--dsw-static-neutral-400)" />
        : <path d={FILE_FOLD} fill="var(--dsw-static-neutral-00)" fillOpacity=".7" />}
      {children !== undefined && (
        <g color="var(--dsw-static-neutral-00)" data-file-type-mark transform={markTransform}>{children}</g>
      )}
    </svg>
  )
}

function FolderGlyph({ size, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        d="M2.80078 10.2112C2.80078 9.52802 2.80078 9.18642 2.85314 8.866C2.98648 8.05 3.36942 7.29538 3.94925 6.70595C4.17694 6.4745 4.45264 6.2728 5.00404 5.86939C5.29197 5.65874 5.43594 5.55342 5.58711 5.46632C5.97089 5.24521 6.39638 5.10618 6.83667 5.05803C7.01011 5.03906 7.18849 5.03906 7.54524 5.03906H11.6543C12.4669 5.03906 12.8732 5.03906 13.2599 5.13697C13.3882 5.16945 13.5143 5.20986 13.6375 5.25795C14.0091 5.40294 14.3398 5.63902 15.0012 6.1112L16.2632 7.01224C16.5526 7.21881 16.6972 7.3221 16.8598 7.38553C16.9137 7.40657 16.9689 7.42425 17.025 7.43846C17.1942 7.4813 17.372 7.4813 17.7275 7.4813H19.8008C22.0506 7.4813 23.1755 7.4813 23.9641 8.05425C24.2188 8.23928 24.4428 8.46326 24.6278 8.71794C25.2008 9.50654 25.2008 10.6315 25.2008 12.8813V18.7283C25.2008 20.9781 25.2008 22.1031 24.6278 22.8917C24.4428 23.1463 24.2188 23.3703 23.9641 23.5554C23.1755 24.1283 22.0506 24.1283 19.8008 24.1283H8.20077C5.95094 24.1283 4.82602 24.1283 4.03743 23.5554C3.78274 23.3703 3.55877 23.1463 3.37373 22.8917C2.80078 22.1031 2.80078 20.9781 2.80078 18.7283V10.2112Z"
        fill="currentColor"
      />
      <g color="var(--dsw-static-neutral-00)" data-file-type-mark transform={FOLDER_MARK_TRANSFORM}>
        <path d="M6.31445 13.0693H21.6893" stroke="currentColor" strokeWidth="2.38" />
      </g>
    </svg>
  )
}

function glyph(type: TraditionalFileType, size: number, className: string | undefined): ReactNode {
  switch (type) {
    case 'code':
      return (
        <FileGlyph size={size} className={className}>
          <path d="M8.61 16.3601L11.76 18.3901V20.1401L7 17.0601V15.6601L11.76 12.5801V14.3301L8.61 16.3601Z" fill="currentColor" />
          <path d="M16.1918 14.3301V12.5801L20.9518 15.6601V17.0601L16.1918 20.1401V18.3901L19.3418 16.3601L16.1918 14.3301Z" fill="currentColor" />
        </FileGlyph>
      )
    case 'excel':
      return (
        <FileGlyph size={size} className={className} markTransform={LARGE_FILE_MARK_TRANSFORM}>
          <path d="M10.2932 20.5L13.3532 16.25L13.3432 17.66L10.4032 13.5H12.6332L14.5132 16.21L13.5632 16.22L15.4132 13.5H17.5532L14.6132 17.58V16.18L17.7132 20.5H15.4332L13.5232 17.65H14.4332L12.5532 20.5H10.2932Z" fill="currentColor" />
        </FileGlyph>
      )
    case 'folder': return <FolderGlyph size={size} className={className} />
    case 'html':
      return (
        <FileGlyph size={size} className={className}>
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M13.9994 9.68298C17.212 9.68298 19.8167 12.2872 19.8168 15.4997C19.8168 18.7123 17.2121 21.3171 13.9994 21.3171C10.7869 21.3169 8.18274 18.7122 8.18274 15.4997C8.1829 12.2873 10.787 9.68315 13.9994 9.68298ZM9.26213 16.0247C9.47025 17.9241 10.7936 19.4876 12.5639 20.0463C12.42 19.7977 12.2952 19.5152 12.1879 19.2116C11.885 18.3541 11.693 17.2434 11.6424 16.0247H9.26213ZM16.3565 16.0247C16.3059 17.2434 16.1145 18.3542 15.8116 19.2116C15.7044 19.5151 15.5788 19.7971 15.435 20.0456C17.2054 19.487 18.5293 17.9242 18.7374 16.0247H16.3565ZM12.6938 16.0247C12.7439 17.1459 12.9212 18.1334 13.1784 18.8616C13.332 19.2962 13.503 19.61 13.6686 19.805C13.834 19.9996 13.9473 20.0256 13.9994 20.0258C14.0514 20.0258 14.1651 20.0002 14.331 19.805C14.4966 19.61 14.6676 19.2962 14.8211 18.8616C15.0784 18.1334 15.2557 17.1459 15.3058 16.0247H12.6938ZM13.9994 10.733C13.9473 10.7331 13.834 10.7598 13.6686 10.9545C13.503 11.1494 13.3319 11.4633 13.1784 11.8978C12.903 12.6777 12.7188 13.7545 12.6849 14.9747H15.3147C15.2808 13.7545 15.0966 12.6777 14.8211 11.8978C14.6676 11.4633 14.4965 11.1494 14.331 10.9545C14.1651 10.7593 14.0514 10.733 13.9994 10.733ZM15.5888 11.0051C15.6701 11.1756 15.7444 11.3576 15.8116 11.5478C16.1343 12.4613 16.3308 13.6619 16.3647 14.9747H18.7374C18.5352 13.1307 17.2817 11.6036 15.5888 11.0051ZM12.4101 11.0051C10.7174 11.6037 9.46428 13.1308 9.26213 14.9747H11.6349C11.6688 13.6619 11.8652 12.4613 12.1879 11.5478C12.2551 11.3577 12.3288 11.1756 12.4101 11.0051Z"
            fill="currentColor"
          />
        </FileGlyph>
      )
    case 'image':
      return (
        <FileGlyph size={size} className={className}>
          <path d="M10.4212 15.9204C10.5756 15.6558 10.9579 15.6558 11.1123 15.9204L13.6493 20.2696C13.8048 20.5362 13.6125 20.8711 13.3037 20.8711H8.22974C7.92102 20.8711 7.72868 20.5362 7.88423 20.2696L10.4212 15.9204Z" fill="currentColor" />
          <path d="M15.4981 13.186C15.6505 12.9117 16.0451 12.9117 16.1975 13.186L20.1368 20.2769C20.2849 20.5435 20.0922 20.8711 19.7872 20.8711H11.9084C11.6034 20.8711 11.4107 20.5435 11.5588 20.2769L15.4981 13.186Z" fill="currentColor" />
          <path d="M11.8603 11.3997C11.8603 12.286 11.1418 13.0045 10.2555 13.0045C9.36924 13.0045 8.65076 12.286 8.65076 11.3997C8.65076 10.5134 9.36924 9.79492 10.2555 9.79492C11.1418 9.79492 11.8603 10.5134 11.8603 11.3997Z" fill="currentColor" />
        </FileGlyph>
      )
    case 'markdown':
      return (
        <FileGlyph size={size} className={className} markTransform={LARGE_FILE_MARK_TRANSFORM}>
          <path d="M8.7588 19.5V14.6H9.8998L11.9298 17.932H11.3278L13.3018 14.6H14.4428L14.4568 19.5H13.1828L13.1688 16.539H13.3858L11.9088 19.017H11.2928L9.7738 16.539H10.0398V19.5H8.7588ZM15.4375 19.5V14.6H17.7545C18.2958 14.6 18.7718 14.7003 19.1825 14.901C19.5932 15.1017 19.9128 15.384 20.1415 15.748C20.3748 16.112 20.4915 16.546 20.4915 17.05C20.4915 17.5493 20.3748 17.9833 20.1415 18.352C19.9128 18.716 19.5932 18.9983 19.1825 19.199C18.7718 19.3997 18.2958 19.5 17.7545 19.5H15.4375ZM16.8235 18.394H17.6985C17.9785 18.394 18.2212 18.3427 18.4265 18.24C18.6365 18.1327 18.7998 17.9787 18.9165 17.778C19.0332 17.5727 19.0915 17.33 19.0915 17.05C19.0915 16.7653 19.0332 16.5227 18.9165 16.322C18.7998 16.1213 18.6365 15.9697 18.4265 15.867C18.2212 15.7597 17.9785 15.706 17.6985 15.706H16.8235V18.394Z" fill="currentColor" />
        </FileGlyph>
      )
    case 'other': return <FileGlyph size={size} className={className} muted />
    case 'pdf':
      return (
        <FileGlyph size={size} className={className} markTransform={LARGE_FILE_MARK_TRANSFORM}>
          <path d="M6.80616 19.5V14.6H9.04616C9.49416 14.6 9.87916 14.6723 10.2012 14.817C10.5278 14.9617 10.7798 15.1717 10.9572 15.447C11.1345 15.7177 11.2232 16.0397 11.2232 16.413C11.2232 16.7817 11.1345 17.1013 10.9572 17.372C10.7798 17.6427 10.5278 17.8527 10.2012 18.002C9.87916 18.1467 9.49416 18.219 9.04616 18.219H7.57616L8.19216 17.617V19.5H6.80616ZM8.19216 17.764L7.57616 17.127H8.96216C9.2515 17.127 9.46616 17.064 9.60616 16.938C9.75083 16.812 9.82316 16.637 9.82316 16.413C9.82316 16.1843 9.75083 16.007 9.60616 15.881C9.46616 15.755 9.2515 15.692 8.96216 15.692H7.57616L8.19216 15.055V17.764ZM11.8989 19.5V14.6H14.2159C14.7573 14.6 15.2333 14.7003 15.6439 14.901C16.0546 15.1017 16.3743 15.384 16.6029 15.748C16.8363 16.112 16.9529 16.546 16.9529 17.05C16.9529 17.5493 16.8363 17.9833 16.6029 18.352C16.3743 18.716 16.0546 18.9983 15.6439 19.199C15.2333 19.3997 14.7573 19.5 14.2159 19.5H11.8989ZM13.2849 18.394H14.1599C14.4399 18.394 14.6826 18.3427 14.8879 18.24C15.0979 18.1327 15.2613 17.9787 15.3779 17.778C15.4946 17.5727 15.5529 17.33 15.5529 17.05C15.5529 16.7653 15.4946 16.5227 15.3779 16.322C15.2613 16.1213 15.0979 15.9697 14.8879 15.867C14.6826 15.7597 14.4399 15.706 14.1599 15.706H13.2849V18.394ZM17.6821 19.5V14.6H21.5251V15.671H19.0681V19.5H17.6821ZM18.9701 17.82V16.749H21.2311V17.82H18.9701Z" fill="currentColor" />
        </FileGlyph>
      )
    case 'ppt':
      return (
        <FileGlyph size={size} className={className} markTransform={LARGE_FILE_MARK_TRANSFORM}>
          <path d="M11.0132 20.5V13.5H14.2132C14.8532 13.5 15.4032 13.6033 15.8632 13.81C16.3299 14.0167 16.6899 14.3167 16.9432 14.71C17.1966 15.0967 17.3232 15.5567 17.3232 16.09C17.3232 16.6167 17.1966 17.0733 16.9432 17.46C16.6899 17.8467 16.3299 18.1467 15.8632 18.36C15.4032 18.5667 14.8532 18.67 14.2132 18.67H12.1132L12.9932 17.81V20.5H11.0132ZM12.9932 18.02L12.1132 17.11H14.0932C14.5066 17.11 14.8132 17.02 15.0132 16.84C15.2199 16.66 15.3232 16.41 15.3232 16.09C15.3232 15.7633 15.2199 15.51 15.0132 15.33C14.8132 15.15 14.5066 15.06 14.0932 15.06H12.1132L12.9932 14.15V18.02Z" fill="currentColor" />
        </FileGlyph>
      )
    case 'video':
      return (
        <FileGlyph size={size} className={className}>
          <path d="M17.5 14.634C18.1667 15.0189 18.1667 15.9811 17.5 16.366L11.5 19.8301C10.8333 20.215 10 19.7339 10 18.9641L10 12.0359C10 11.2661 10.8333 10.785 11.5 11.1699L17.5 14.634Z" fill="currentColor" />
        </FileGlyph>
      )
    case 'word':
      return (
        <FileGlyph size={size} className={className} markTransform={LARGE_FILE_MARK_TRANSFORM}>
          <path d="M10.5118 20.5L8.24179 13.5H10.2818L12.1918 19.56H11.1618L13.1718 13.5H14.9918L16.8918 19.56H15.9018L17.8718 13.5H19.7618L17.4918 20.5H15.3718L13.7518 15.35H14.3218L12.6318 20.5H10.5118Z" fill="currentColor" />
        </FileGlyph>
      )
    /* v8 ignore next -- closed-union backstop; only reached if a type is forged */
    default: return assertNever(type)
  }
}

/** Closed-union exhaustiveness guard for traditional file artwork. */
/* v8 ignore next 3 -- only reachable when an untyped caller forges a traditional file type */
function assertNever(value: never): never {
  throw new Error(`unreachable traditional file type: ${String(value)}`)
}

/**
 * Render a decorative file-type glyph for a path or an explicitly resolved kind.
 * @param props - Path or kind selection, optional project context, size, and CSS class.
 * @returns The category-colored SVG; the caller owns the accessible name and may override
 * the color through `--dsh-file-type-icon-color`.
 */
export function FileTypeIcon(props: FileTypeIconProps): ReactNode {
  const { size = 28, className } = props
  const resolvedType = 'path' in props
    ? classifyFileType(props.path, props.context)
    : props.kind
  return isCodeFileType(resolvedType)
    ? <CodeFileIcon type={resolvedType} size={size} className={className} />
    : glyph(resolvedType, size, clsx(css.icon, css[resolvedType], className))
}
