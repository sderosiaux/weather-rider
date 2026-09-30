import { defineConfig, type Plugin } from 'vite'

/**
 * Strict CSP for production builds only: the game is 100% same-origin (no CDN, no eval, no inline
 * script or handler, styles via CSSOM). Dev keeps Vite's inline style injection and HMR socket.
 * frame-ancestors can't be set from a meta tag: add it as an HTTP header wherever this is hosted.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const productionCsp = (): Plugin => ({
  name: 'weather-rider-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

export default defineConfig({
  plugins: [productionCsp()],
})
