// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "@/lib/auth";

const mockSetLocation = vi.fn();
const mockToast = vi.fn();

vi.mock("wouter", () => ({
  useLocation: () => ["/", mockSetLocation],
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

function Wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = createTestQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function AuthState() {
  const { user } = useAuth();
  return <div>{user?.username ?? "no-user"}</div>;
}

describe("AuthProvider /api/auth/me handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("token", "test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears stored token on 401 responses", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/status") {
        return jsonResponse(200, { hasUsers: true });
      }
      if (url === "/api/auth/me") {
        return jsonResponse(401, {});
      }
      throw new Error(`Unhandled URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <Wrapper>
        <AuthProvider>
          <div>test</div>
        </AuthProvider>
      </Wrapper>
    );

    await waitFor(() => {
      expect(localStorage.getItem("token")).toBeNull();
    });

    const meCalls = fetchMock.mock.calls.filter(
      (call) => String(call[0]) === "/api/auth/me"
    ).length;
    expect(meCalls).toBe(1);
  });

  it("authenticates proxy-auth users without a stored token", async () => {
    localStorage.removeItem("token");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/status") {
        return jsonResponse(200, { hasUsers: true });
      }
      if (url === "/api/auth/me") {
        expect(init?.headers).not.toHaveProperty("Authorization");
        return jsonResponse(200, { id: "1", username: "sam" });
      }
      throw new Error(`Unhandled URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { getByText } = render(
      <Wrapper>
        <AuthProvider>
          <AuthState />
        </AuthProvider>
      </Wrapper>
    );

    await waitFor(() => {
      expect(getByText("sam")).toBeInTheDocument();
    });

    expect(localStorage.getItem("token")).toBeNull();
    expect(mockSetLocation).not.toHaveBeenCalledWith("/login");
  });

  it("clears stored token on 403 responses", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/status") {
        return jsonResponse(200, { hasUsers: true });
      }
      if (url === "/api/auth/me") {
        return jsonResponse(403, {});
      }
      throw new Error(`Unhandled URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <Wrapper>
        <AuthProvider>
          <div>test</div>
        </AuthProvider>
      </Wrapper>
    );

    await waitFor(() => {
      expect(localStorage.getItem("token")).toBeNull();
    });

    const meCalls = fetchMock.mock.calls.filter(
      (call) => String(call[0]) === "/api/auth/me"
    ).length;
    expect(meCalls).toBe(1);
  });

  it("does not clear token and throws error on 500 server responses", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/status") {
        return jsonResponse(200, { hasUsers: true });
      }
      if (url === "/api/auth/me") {
        return jsonResponse(500, { error: "Internal Server Error" });
      }
      throw new Error(`Unhandled URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <Wrapper>
        <AuthProvider>
          <div>test</div>
        </AuthProvider>
      </Wrapper>
    );

    await waitFor(() => {
      const meCalls = fetchMock.mock.calls.filter(
        (call) => String(call[0]) === "/api/auth/me"
      ).length;
      expect(meCalls).toBeGreaterThan(0);
    });

    // Token must not be cleared for server errors
    expect(localStorage.getItem("token")).toBe("test-token");
  });

  it("keeps stored token and retries on transient failures", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/status") {
        return jsonResponse(200, { hasUsers: true });
      }
      if (url === "/api/auth/me") {
        throw new TypeError("Network error");
      }
      throw new Error(`Unhandled URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <Wrapper>
        <AuthProvider>
          <div>test</div>
        </AuthProvider>
      </Wrapper>
    );

    await waitFor(() => {
      const meCalls = fetchMock.mock.calls.filter(
        (call) => String(call[0]) === "/api/auth/me"
      ).length;
      expect(meCalls).toBeGreaterThan(0);
    });

    await waitFor(
      () => {
        const meCalls = fetchMock.mock.calls.filter(
          (call) => String(call[0]) === "/api/auth/me"
        ).length;
        expect(meCalls).toBeGreaterThan(1);
      },
      { timeout: 9000, interval: 100 }
    );

    expect(localStorage.getItem("token")).toBe("test-token");
  }, 12000);
});
