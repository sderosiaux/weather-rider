// Drives one named agent-browser session through its CLI (--json replies). No npm dependency.
// agent-browser 0.23 quirks this works around:
// - `console --clear` also stops page-error capture until the next navigation, and `errors --clear` is a no-op.
//   Both buffers are session-wide and append-only, so problems are read as "everything after a mark".
// - Any command, `close` included, spawns the session's daemon if it isn't running (it exits again after `close`).
import { execFile } from 'node:child_process'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const firstLines = (text, n) => String(text).split('\n').slice(0, n).map((l) => l.trim()).join(' ')

export function createBrowser(session, { callTimeoutMs = 60_000 } = {}) {
  const run = (args, timeoutMs, sessionArgs) =>
    new Promise((resolve, reject) => {
      execFile('agent-browser', [...sessionArgs, '--json', ...args], { timeout: timeoutMs, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
        if (err?.code === 'ENOENT') return reject(new Error('agent-browser CLI not found on PATH'))
        let reply
        try {
          reply = JSON.parse(stdout)
        } catch {
          return reject(new Error(`agent-browser ${args[0]}: ${(stderr || stdout || err?.message || 'no reply').trim()}`))
        }
        if (reply.success) resolve(reply.data)
        else reject(new Error(`agent-browser ${args.slice(0, 2).join(' ')}: ${reply.error}`))
      })
    })
  const call = (args, timeoutMs = callTimeoutMs) => run(args, timeoutMs, ['--session', session])

  /** Runs `fn(arg)` in the page, awaiting promises. `fn` travels as source: no closures, JSON-serializable arg and result. */
  const evaluate = async (fn, arg) => {
    const src = `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})`
    return (await call(['eval', '-b', Buffer.from(src).toString('base64')])).result
  }

  /** Polls `fn(arg)` in the page until `ready(value)`; the timeout error carries the last value seen. */
  const waitFor = async (what, fn, arg, { timeoutMs = 10_000, intervalMs = 150, ready = Boolean } = {}) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await evaluate(fn, arg)
      if (ready(value)) return value
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what} (last: ${JSON.stringify(value)})`)
      await delay(intervalMs)
    }
  }

  return {
    session,
    open: (url) => call(['open', url]),
    reload: () => call(['reload']),
    viewport: (width, height) => call(['set', 'viewport', String(width), String(height)]),
    click: (selector) => call(['click', selector]),
    /** By role + exact accessible name: what the player reads, not how the ui module styles it. */
    clickButton: (name) => call(['find', 'role', 'button', 'click', '--name', name, '--exact']),
    checkLabel: (label) => call(['find', 'label', label, 'check']),
    focus: (selector) => call(['focus', selector]),
    press: (key) => call(['press', key]),
    clickAt: async (x, y) => {
      await call(['mouse', 'move', String(x), String(y)])
      await call(['mouse', 'down'])
      await call(['mouse', 'up'])
    },
    screenshot: async (path) => (await call(['screenshot', '--screenshot-format', 'png', path])).path,
    evaluate,
    waitFor,
    logMark: async () => ({ console: (await call(['console'])).messages.length, errors: (await call(['errors'])).errors.length }),
    /** Uncaught page errors and console.error calls since `mark`, one line each. */
    problemsSince: async (mark) => {
      const { messages } = await call(['console'])
      const { errors } = await call(['errors'])
      return [
        ...errors.slice(mark.errors).map((e) => `page error: ${firstLines(e.text, 2)}`),
        ...messages.slice(mark.console).filter((m) => m.type === 'error').map((m) => `console.error: ${firstLines(m.text, 2)}`),
      ]
    },
    close: () => call(['close'], 30_000),
    /** The daemon exits a moment after `close`: true once this session is gone from `session list`. */
    closed: async ({ timeoutMs = 5000 } = {}) => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const { sessions = [] } = await run(['session', 'list'], 15_000, [])
        if (!sessions.includes(session)) return true
        if (Date.now() > deadline) return false
        await delay(200)
      }
    },
  }
}
