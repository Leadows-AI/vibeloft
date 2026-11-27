// Small per-computer view preferences (panels open or collapsed), kept in this
// computer's local storage so they survive restarts.

const key = (name: string): string => `vibeloft.${name}`

export function remembered(name: string, fallback: string): string {
  try {
    return localStorage.getItem(key(name)) ?? fallback
  } catch {
    return fallback
  }
}

export function remember(name: string, value: string): void {
  try {
    localStorage.setItem(key(name), value)
  } catch {
    /* storage unavailable */
  }
}
