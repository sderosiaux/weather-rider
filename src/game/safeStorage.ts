export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * localStorage can throw on mere access (site data blocked, sandboxed iframe): fall back to memory so the
 * game still boots and plays; progress just won't survive a reload.
 */
export function safeStorage(get: () => Storage = () => window.localStorage): { storage: KeyValueStorage; persistent: boolean } {
  try {
    const s = get()
    s.getItem('weather-rider/probe')
    return { storage: s, persistent: true }
  } catch (err) {
    console.warn('localStorage unavailable, progress will not be saved', err)
    const mem = new Map<string, string>()
    return {
      persistent: false,
      storage: {
        getItem: (k) => mem.get(k) ?? null,
        setItem: (k, v) => void mem.set(k, String(v)),
        removeItem: (k) => void mem.delete(k),
      },
    }
  }
}
