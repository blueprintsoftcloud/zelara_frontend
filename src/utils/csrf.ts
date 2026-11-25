// Reads the non-httpOnly `csrfToken` cookie the backend sets on every response
// (see backend/src/middleware/csrf.middleware.ts) so it can be echoed back as the
// X-CSRF-Token header on mutating requests — the standard double-submit-cookie pattern.
export const getCsrfToken = (): string | null => {
  const match = document.cookie.match(/(?:^|;\s*)csrfToken=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
};

let pendingBootstrap: Promise<string | null> | null = null;

// Bootstraps the csrfToken cookie via GET /auth/csrf when a mutating request runs
// before any prior GET has populated document.cookie (e.g. direct login/feedback actions).
export const ensureCsrfToken = async (baseUrl: string): Promise<string | null> => {
  const existing = getCsrfToken();
  if (existing) return existing;

  if (!pendingBootstrap) {
    pendingBootstrap = (async () => {
      try {
        const normalizedBase = baseUrl.replace(/\/+$/, "");
        const res = await fetch(`${normalizedBase}/auth/csrf`, {
          method: "GET",
          credentials: "include",
        });
        if (!res.ok) return getCsrfToken();
        const data = (await res.json()) as { csrfToken?: string };
        return (
          getCsrfToken() ||
          (typeof data?.csrfToken === "string" && data.csrfToken ? data.csrfToken : null)
        );
      } catch {
        return getCsrfToken();
      } finally {
        pendingBootstrap = null;
      }
    })();
  }

  return pendingBootstrap;
};
