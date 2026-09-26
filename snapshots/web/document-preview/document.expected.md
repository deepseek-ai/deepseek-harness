# Document preview

## Sidebar tabs

- Default tab: Files
- Files close buttons (alone -> with guide -> restored): 1 -> 1 -> 1
- Manual guide close buttons: 1
- Add buttons (Files -> guide -> Files): 1 -> 0 -> 1

## Markdown

- Heading: Markdown smoke
- Tail loaded by scrolling: Markdown tail
- Loaded images: relative image | absolute image | reference image
- Viewers: Markdown -> Code -> Plain text
- Same tab: true

## Basic HTML

- Developer tools: disabled for this scenario
- Sandbox: no permissions
- Inline script: pending
- Local script: pending
- Network requests: 0

## HTML

- Viewer: HTML
- Sandbox: allow-scripts
- Inline script: INLINE_OK
- Local script after save: LOCAL_JS_REFRESHED
- Outside-workspace script: OUTSIDE_JS_OK
- Local stylesheet after save: rgb(56, 34, 12)
- Parent access: parent-blocked (SecurityError)
- Parent unchanged: true

## PDF

- Viewer menu hidden: true
- Worker: dsh-pdf
- Continuous pages: 2
- Zoom reveal: hidden -> bottom hover -> delayed hidden
- Zoom modes: fit width -> 100% -> 150% -> fit width
- Paper layout: 12px page gaps and outer backdrop insets in both themes
- Settled zoom redraws the page at device resolution
- Horizontal overflow: false
- Canvas fills: red -> blue -> blue
- Same tab: true
- Selected and copied text: Selectable PDF text

## PDF page units

- UserUnit 2: selected and copied text aligns with the canvas

## PDF page rotation

- 90, 180, 270 degrees: selection and copied text align with canvas ink before and after resizing

## PDF drag selection

- Table selection: forward and backward drags exclude later sections
- Line-break highlight: transparent

## Image zoom

- Small PNG fit width remains at intrinsic size; 200% doubles it
- SVG fit width -> 100% -> fit width toggles horizontal overflow: false -> true -> false
- Image and Blob identities remain stable while zoom changes

## Code paging

- Viewer: Code
- Initial reading indicator: true
- Loading feedback: centered 28px spinner with "Rendering document..."
- Lines: 64 -> 65
- Prefix retained: true
- Tail: const tail = "CODE_TAIL";

## Office unavailable

- DOC, DOCX, PPT, PPTX viewer menus: 0 | 0 | 0 | 0
- Guidance: Read failed: Office previews are unavailable. Enable the document preview service on the computer running DeepSeek Harness.
- Binary text shown: false
- Plain-text option and viewer picker: hidden

## Browser Excel preview

- Opens without the Office conversion service
- Sheets: 季度预算 | 公式与格式; hidden worksheet omitted
- Formula workbooks use a compact warning beside fx; notice rows absent
- Unsupported XLSX content: This preview does not support charts, conditional formatting in this workbook. Open it in a system application for the full experience.
- Drawing parts omitted; styled cells and cached formulas retained; notice cleared on file replacement
- Formatted percent copied: 80.0%; date copied: 2026-09-16
- Cached XLOOKUP result copied: 42; typing leaves it unchanged
- Formula bar is read-only; PDF body and editing toolbar absent
- HTML-looking formulas, text, and cached results stay literal; copying retains text and table cells without executing HTML
- XLS: merged title copied; worksheet selection retained
- Invalid XLS/XLSX: This spreadsheet could not be opened. Check its format, contents, or password protection.

## Delimited spreadsheets

- CSV and TSV default to Spreadsheet; Plain text remains selectable
- Copied ID: 00123; copied literal formula: =SUM(1,2)
- Plain-text round trip retains complete source lines
- Reload replaces parsed cells: 00123 -> 00999

## Unknown suffix

- Viewer menu hidden: true
- Text: UNKNOWN_SUFFIX | Plain fallback.

## Unviewable binary

- State: unsupported
- Line: Preview is not available for this file type yet.
- Header control has no text: true
- Empty-state control has text: true
