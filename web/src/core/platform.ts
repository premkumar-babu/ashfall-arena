export const REDUCED_MOTION: boolean = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/*
  localStorage throws rather than returning null in several real situations:
  private browsing on some browsers, storage disabled by policy, and an iframe
  sandboxed without storage access — which is exactly how itch.io embeds a
  game. Every read and write goes through these, so a missing store costs the
  saved preference and never the page.
*/
export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* preference simply is not saved */
  }
}

export function storageGetJSON<T>(key: string): T | null {
  const raw = storageGet(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function storageSetJSON(key: string, value: unknown): void {
  storageSet(key, JSON.stringify(value));
}

export function queryFlag(name: string): boolean {
  return new URLSearchParams(window.location.search).has(name);
}

export function queryParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}
