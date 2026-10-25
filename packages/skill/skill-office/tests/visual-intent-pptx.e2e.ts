/** Real Office visual-intent e2e cases for PPTX documents, including the blank-preview case. */
import { registerVisualIntentCases } from './fixtures/visual-intent.ts'

registerVisualIntentCases(['pptx'], { blank: true })
