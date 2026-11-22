import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FONT_PACKAGES = join(import.meta.dirname, '..', '..', 'node_modules', '@fontsource-variable')

// Fonts are served from our own origin so the checkout page needs no third party.
const fontFiles = {
  'jetbrains-mono.woff2': join(FONT_PACKAGES, 'jetbrains-mono', 'files', 'jetbrains-mono-latin-wght-normal.woff2'),
  'golos-text.woff2': join(FONT_PACKAGES, 'golos-text', 'files', 'golos-text-latin-wght-normal.woff2'),
}

export const fonts: ReadonlyMap<string, Buffer> = new Map(
  Object.entries(fontFiles).map(([name, path]) => [name, readFileSync(path)]),
)
