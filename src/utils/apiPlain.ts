import axios from "axios";
import { domainUrl } from "./constant";
import { ensureCsrfToken, getCsrfToken } from "./csrf";

// Plain axios instance — no auto-refresh/retry interceptors.
// Used for requests that should NOT trigger the auto-refresh loop (e.g. auth/status).
const apiPlain = axios.create({
  baseURL: domainUrl,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

const SAFE_METHODS = new Set(["get", "head", "options"]);

apiPlain.interceptors.request.use(async (config) => {
  const method = (config.method || "get").toLowerCase();
  let token = getCsrfToken();
  if (!token && !SAFE_METHODS.has(method)) {
    token = await ensureCsrfToken(config.baseURL || domainUrl);
  }
  if (token) config.headers["X-CSRF-Token"] = token;
  return config;
});

export default apiPlain;
