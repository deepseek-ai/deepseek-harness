/** CSS Modules compiled into the browser bundle. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
