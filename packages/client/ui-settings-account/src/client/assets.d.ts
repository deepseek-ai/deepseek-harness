/** Illustration imports are embedded in the account client bundle. */
declare module '*.png' {
  const svg: string
  export default svg
}
declare module '*.svg' {
  const url: string
  export default url
}
