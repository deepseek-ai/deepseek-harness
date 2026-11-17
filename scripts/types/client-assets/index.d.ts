/**
 * Package images under `src/client/assets/`: the client build preset replaces
 * each import with the asset's document-relative, content-revisioned URL.
 * The module names mirror the supported extensions of the client-modules
 * asset format.
 */
declare module '*.svg' {
  const url: string
  export default url
}

declare module '*.png' {
  const url: string
  export default url
}

declare module '*.webp' {
  const url: string
  export default url
}

declare module '*.jpg' {
  const url: string
  export default url
}

declare module '*.jpeg' {
  const url: string
  export default url
}
