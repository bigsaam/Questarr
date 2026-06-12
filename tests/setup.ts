import "@testing-library/jest-dom";
import { vi } from "vitest";

// Set environment variables for testing
process.env.NODE_ENV = "test";
process.env.SQLITE_DB_PATH = ":memory:";

global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Better class-based mock for ResizeObserver
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
global.ResizeObserver = MockResizeObserver as any;

// jsdom does not implement scrollIntoView; stub it to prevent errors in cmdk/Radix popups
if (typeof window !== "undefined") {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();

  if (typeof window.localStorage?.clear !== "function") {
    const store = new Map<string, string>();
    const localStorageMock: Storage = {
      get length() {
        return store.size;
      },
      clear: vi.fn(() => store.clear()),
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, String(value));
      }),
    };

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorageMock,
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: localStorageMock,
    });
  }
}
