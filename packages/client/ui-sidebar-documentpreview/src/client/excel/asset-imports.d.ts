/** Build-owned parser Worker source embedded in the lazy Excel chunk. */
declare module '*.ts?raw' {
  const source: string
  export default source
}

/** FortuneSheet's stylesheet is scoped by the preview component. */
declare module '@fortune-sheet/react/dist/index.css?inline' {
  const source: string
  export default source
}
