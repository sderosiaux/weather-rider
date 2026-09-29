// Ghost sharing without a server: the encoded ghost rides in the URL fragment (never sent to any host).
const PARAM = 'g'

/** Replaces any existing fragment of baseUrl. */
export function shareUrl(baseUrl: string, ghostCode: string): string {
  const hashAt = baseUrl.indexOf('#')
  const base = hashAt === -1 ? baseUrl : baseUrl.slice(0, hashAt)
  return `${base}#${PARAM}=${encodeURIComponent(ghostCode)}`
}

/**
 * Accepts `location.hash` ("#g=…"), a full pasted share URL, or a bare ghost code.
 * Returns null when there's nothing usable. Decoding the ghost itself is the ghost codec's job.
 * Manual parsing on purpose: URLSearchParams turns '+' into a space and would corrupt base64 codes.
 */
export function parseShareHash(input: string): string | null {
  const s = input.trim()
  if (s === '') return null
  const hashAt = s.indexOf('#')
  if (hashAt === -1) {
    if (s.startsWith(`${PARAM}=`)) return decodeParam(s.slice(PARAM.length + 1))
    // A URL without our fragment carries no ghost; anything else is taken as a raw code.
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /\s/.test(s) ? null : s
  }
  for (const part of s.slice(hashAt + 1).split('&')) {
    if (part.startsWith(`${PARAM}=`)) return decodeParam(part.slice(PARAM.length + 1))
  }
  return null
}

function decodeParam(v: string): string | null {
  try {
    const code = decodeURIComponent(v)
    return code === '' ? null : code
  } catch {
    return null
  }
}
