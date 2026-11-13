import { useEffect, useState } from 'react';

/** A value that follows `value` after it has stopped changing for `delayMs` (search boxes). */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Whether a CSS media query matches right now, and keeps matching as the window changes. Where the
 * browser cannot answer (an old one, or a test environment), `fallback` is used.
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const [matches, setMatches] = useState(() =>
    supported ? window.matchMedia(query).matches : fallback,
  );
  useEffect(() => {
    if (!supported) return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query, supported]);
  return matches;
}

/** Whole seconds left until `iso`, ticking once a second (0 once it has passed, or when `iso` is null). */
export function useSecondsLeft(iso: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [iso]);
  return iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000)) : 0;
}
