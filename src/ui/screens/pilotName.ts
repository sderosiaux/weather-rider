// Pilot names are user text: yours from Settings, everyone else's from inside their ghost codes. No DOM.

/** Same bound as Settings.pilotName (the shell cuts at 20 UTF-16 units). */
export const PILOT_NAME_MAX = 20
/** Shown when a ghost carries nothing printable. */
export const UNNAMED = 'Unnamed pilot'

// Control, format (zero-width, U+202E and the other direction overrides) and lone surrogate code points
// never reach the screen: an override would flip the rank and score around the name.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}]/gu
// Stacked combining marks paint over the rows above and below. Three per letter covers real scripts.
const MARK_PILE = /(\p{M}{3})\p{M}+/gu
// A ghost code can carry any length; nothing past this can survive the 20-character display anyway.
const RAW_BOUND = 512
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export const cleanName = (raw: string): string =>
  raw.slice(0, RAW_BOUND).normalize('NFC').replace(INVISIBLE, '').replace(MARK_PILE, '$1').replace(/\s+/g, ' ').trim()

/** What the Settings field commits: at most PILOT_NAME_MAX UTF-16 units, never half an emoji. Empty = nothing usable. */
export const pilotNameFrom = (raw: string): string => {
  const clean = cleanName(raw)
  if (clean.length <= PILOT_NAME_MAX) return clean
  const cut = clean.slice(0, PILOT_NAME_MAX)
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd()
}

/** Board text for any name, trusted or not: cleaned, ellipsized past PILOT_NAME_MAX characters. Render as text only. */
export const displayName = (raw: string): string => {
  const clean = cleanName(raw)
  if (clean.length === 0) return UNNAMED
  const chars = Array.from(graphemes.segment(clean), (s) => s.segment)
  return chars.length <= PILOT_NAME_MAX ? clean : `${chars.slice(0, PILOT_NAME_MAX - 1).join('').trimEnd()}…`
}
