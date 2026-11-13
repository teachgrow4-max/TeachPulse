import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

// jsdom has no layout engine; these are the few browser APIs the app touches at render time.
// A test window is a wide one: every `min-width` query matches (so the app shows its desktop layout:
// the sidebar, tables) and no `max-width` one does. A test that is about the phone layout replaces
// `window.matchMedia` with an answer of its own.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: /min-width/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// Radix UI measures elements; the stub keeps it quiet.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

// Radix Dialog expects these on elements.
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
