// src/login/useLoginFlow.ts
// Encapsulates all login/OTP/forgot-password state and async handlers.
// The Login component is kept as a pure presentational shell.

import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import api from "../utils/api";
import { useAuth } from "../context/AuthContext";

// ── Step type ─────────────────────────────────────────────────────────────────
export type LoginStep =
  | "credentials" // email + password form
  | "otp" // OTP verification after login
  | "forgot-email" // enter registered email to reset password
  | "forgot-otp" // OTP verification for password reset
  | "forgot-reset"; // enter + confirm new password

// ── Error helper (removes all `any` casts from handlers) ─────────────────────
interface ApiError {
  response?: {
    status?: number;
    data?: {
      message?: string;
      code?: string;
      attemptsRemaining?: number;
      retryAfterSeconds?: number;
    };
  };
}
function getErrorMessage(err: unknown, fallback: string): string {
  return (err as ApiError)?.response?.data?.message ?? fallback;
}
function getErrorCode(err: unknown): string | undefined {
  return (err as ApiError)?.response?.data?.code;
}
function getRetryAfterSeconds(err: unknown): number | undefined {
  return (err as ApiError)?.response?.data?.retryAfterSeconds;
}

const DEAD_CHALLENGE_CODES = new Set([
  "CHALLENGE_MISSING",
  "CHALLENGE_INVALID",
  "CHALLENGE_EXPIRED",
  "CHALLENGE_CONSUMED",
  "CHALLENGE_LOCKED",
  "AUTH_NOT_VERIFIED",
  "TOKEN_VERSION_MISMATCH",
  "MAX_RESENDS_EXCEEDED",
]);

// ── Email validator ───────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useLoginFlow() {
  const navigate = useNavigate();
  const { user, checkAuthStatus } = useAuth();

  // ── UI step ──────────────────────────────────────────────────────
  const [step, setStep] = useState<LoginStep>("credentials");
  const [loading, setLoading] = useState(false);

  // ── Credentials ───────────────────────────────────────────────────
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // ── OTP (shared for login-OTP and forgot-OTP steps) ───────────────
  const [otp, setOtp] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [resetChallengeId, setResetChallengeId] = useState("");

  // ── Forgot-password fields ────────────────────────────────────────
  const [resetEmail, setResetEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // ── Resend countdown (seconds) ────────────────────────────────────
  const [timer, setTimer] = useState(0);

  // ── Redirect once the user is authenticated ───────────────────────
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (redirectedRef.current || user.isInitialLoad || !user.isAuthenticated)
      return;
    redirectedRef.current = true;

    const role = user.role?.toUpperCase() ?? "";
    navigate(
      role === "STAFF"
        ? "/staff-dashboard"
        : role === "SUPER_ADMIN"
          ? "/super-admin-dashboard"
          : role === "ADMIN"
            ? "/admin-dashboard"
            : "/",
      { replace: true },
    );
  }, [user, navigate]);

  // ── Timer countdown ───────────────────────────────────────────────
  useEffect(() => {
    if (timer <= 0) return;
    const id = setInterval(() => setTimer((t) => t - 1), 1000);
    return () => clearInterval(id);
  }, [timer]);

  // ── Helpers ───────────────────────────────────────────────────────
  const startTimer = (seconds = 120) => setTimer(seconds); // default 2 minutes resend cooldown
  const clearOtp = () => setOtp("");

  /** Format seconds as MM:SS */
  const formatTimer = (s: number): string =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  // ── Step 1 — submit credentials, get OTP ─────────────────────────
  const handleLoginSubmit = useCallback(async () => {
    if (!email.trim() || !password.trim()) {
      toast.error("Please enter your email and password", { id: "validation" });
      return;
    }
    if (!EMAIL_RE.test(email)) {
      toast.error("Please enter a valid email address", { id: "email-format" });
      return;
    }

    try {
      setLoading(true);
      const res = await api.post<{
        step: string;
        challengeId?: string;
        resendAfterSeconds?: number;
      }>("/auth/login", {
        email: email.trim().toLowerCase(),
        password,
      });

      if (res.data.step === "VERIFY_OTP") {
        setChallengeId(res.data.challengeId ?? "");
        toast.success("OTP sent to your email", { id: "otp-sent" });
        clearOtp();
        setStep("otp");
        startTimer(res.data.resendAfterSeconds ?? 120);
      }
    } catch (err) {
      const retryAfter = getRetryAfterSeconds(err);
      if (retryAfter) startTimer(retryAfter);
      toast.error(getErrorMessage(err, "Login failed"), { id: "login-failed" });
    } finally {
      setLoading(false);
    }
  }, [email, password]);

  // ── Step 2 — verify login OTP ─────────────────────────────────────
  const handleVerifyOtp = useCallback(async (customOtp?: string) => {
    const targetOtp = (customOtp ?? otp).trim();
    if (targetOtp.length !== 6) {
      toast.error("Please enter the complete 6-digit code", {
        id: "otp-incomplete",
      });
      return;
    }

    try {
      setLoading(true);
      const res = await api.post<{ message: string; role?: string }>(
        "/auth/login/verify",
        {
          email: email.trim().toLowerCase(),
          otp: targetOtp,
          ...(challengeId ? { challengeId } : {}),
        },
        { timeout: 15000 }
      );
      toast.success("Login successful!", { id: "login-success" });
      setChallengeId("");

      // checkAuthStatus updates the AuthContext with the new session
      await checkAuthStatus();

      // Immediately redirect to the matching dashboard without waiting for effect cycle
      const role = (res.data?.role || user.role || "").toUpperCase();
      redirectedRef.current = true;
      navigate(
        role === "STAFF"
          ? "/staff-dashboard"
          : role === "SUPER_ADMIN"
            ? "/super-admin-dashboard"
            : role === "ADMIN"
              ? "/admin-dashboard"
              : "/",
        { replace: true },
      );
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string; response?: { status?: number } };
      const code = getErrorCode(err);
      if (e?.code === "ECONNABORTED" || e?.message?.includes("timeout")) {
        toast.error("Verification timed out. Please check your connection and try again.", {
          id: "otp-timeout",
        });
      } else {
        toast.error(getErrorMessage(err, "OTP verification failed"), {
          id: "otp-failed",
          duration: 5000,
        });
        clearOtp();
        if ((code && DEAD_CHALLENGE_CODES.has(code)) || e?.response?.status === 403 || code === "ROLE_RESTRICTED" || code === "ACCOUNT_DEACTIVATED") {
          setChallengeId("");
          setTimer(0);
          setStep("credentials");
        }
      }
    } finally {
      setLoading(false);
    }
  }, [email, otp, challengeId, checkAuthStatus, navigate, user.role]);

  // ── Resend OTP (login flow) ───────────────────────────────────────
  const handleResendOtp = useCallback(async () => {
    if (timer > 0) return;

    try {
      setLoading(true);
      const res = await api.post<{ challengeId?: string; resendAfterSeconds?: number }>(
        "/auth/resend-otp",
        {
          email: email.trim().toLowerCase(),
          ...(challengeId ? { challengeId } : {}),
        },
        { timeout: 15000 },
      );
      if (res.data?.challengeId) {
        setChallengeId(res.data.challengeId);
      }
      toast.success("OTP resent to your email", { id: "otp-resent" });
      clearOtp();
      startTimer(res.data?.resendAfterSeconds ?? 120);
    } catch (err) {
      const code = getErrorCode(err);
      const retryAfter = getRetryAfterSeconds(err);
      if (code === "RESEND_COOLDOWN" && retryAfter) {
        startTimer(retryAfter);
      }
      toast.error(getErrorMessage(err, "Resend failed"), {
        id: "otp-resend-fail",
      });
      if (code && DEAD_CHALLENGE_CODES.has(code)) {
        clearOtp();
        setChallengeId("");
        setTimer(0);
        setStep("credentials");
      }
    } finally {
      setLoading(false);
    }
  }, [email, timer, challengeId]);

  // ── Forgot step 1 — send reset OTP ───────────────────────────────
  const handleForgotSubmit = useCallback(async () => {
    if (!resetEmail.trim() || !EMAIL_RE.test(resetEmail)) {
      toast.error("Please enter a valid email address", {
        id: "forgot-email-invalid",
      });
      return;
    }

    try {
      setLoading(true);
      const res = await api.post<{
        challengeId?: string;
        resendAfterSeconds?: number;
      }>(
        "/auth/forgot-password",
        { email: resetEmail.trim().toLowerCase() },
        { timeout: 15000 },
      );
      setResetChallengeId(res.data?.challengeId ?? "");
      toast.success("If an eligible account exists, a code has been sent", { id: "forgot-otp-sent" });
      clearOtp();
      setStep("forgot-otp");
      startTimer(res.data?.resendAfterSeconds ?? 120);
    } catch (err) {
      const retryAfter = getRetryAfterSeconds(err);
      if (retryAfter) startTimer(retryAfter);
      toast.error(getErrorMessage(err, "Failed to send OTP"), {
        id: "forgot-fail",
      });
    } finally {
      setLoading(false);
    }
  }, [resetEmail]);

  // ── Forgot step 2 — verify reset OTP ─────────────────────────────
  const handleVerifyResetOtp = useCallback(async (customOtp?: string) => {
    const targetOtp = (customOtp ?? otp).trim();
    if (targetOtp.length !== 6) {
      toast.error("Please enter the complete 6-digit code", {
        id: "reset-otp-incomplete",
      });
      return;
    }

    try {
      setLoading(true);
      await api.post(
        "/auth/verify-reset-otp",
        {
          email: resetEmail.trim().toLowerCase(),
          otp: targetOtp,
          ...(resetChallengeId ? { challengeId: resetChallengeId } : {}),
        },
        { timeout: 15000 },
      );
      toast.success("OTP verified — set your new password", {
        id: "reset-otp-verified",
      });
      setStep("forgot-reset");
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      const code = getErrorCode(err);
      if (e?.code === "ECONNABORTED" || e?.message?.includes("timeout")) {
        toast.error("Verification timed out. Please check your connection and try again.", {
          id: "reset-otp-timeout",
        });
      } else {
        toast.error(getErrorMessage(err, "Invalid or expired OTP"), {
          id: "reset-otp-fail",
        });
        clearOtp();
        if ((code && DEAD_CHALLENGE_CODES.has(code)) || code === "ROLE_RESTRICTED") {
          setResetChallengeId("");
          setTimer(0);
          setStep("forgot-email");
        }
      }
    } finally {
      setLoading(false);
    }
  }, [resetEmail, otp, resetChallengeId]);

  // ── Resend OTP (forgot-password flow) ────────────────────────────
  const handleResendResetOtp = useCallback(async () => {
    if (timer > 0) return;

    try {
      setLoading(true);
      const res = await api.post<{ challengeId?: string; resendAfterSeconds?: number }>(
        "/auth/forgot-password/resend-otp",
        {
          email: resetEmail.trim().toLowerCase(),
          ...(resetChallengeId ? { challengeId: resetChallengeId } : {}),
        },
        { timeout: 15000 },
      );
      if (res.data?.challengeId) {
        setResetChallengeId(res.data.challengeId);
      }
      toast.success("New verification code sent if account is eligible", { id: "reset-resent" });
      clearOtp();
      startTimer(res.data?.resendAfterSeconds ?? 120);
    } catch (err) {
      const code = getErrorCode(err);
      const retryAfter = getRetryAfterSeconds(err);
      if (code === "RESEND_COOLDOWN" && retryAfter) {
        startTimer(retryAfter);
      }
      toast.error(getErrorMessage(err, "Resend failed"), {
        id: "reset-resend-fail",
      });
      if (code && DEAD_CHALLENGE_CODES.has(code)) {
        clearOtp();
        setResetChallengeId("");
        setTimer(0);
        setStep("forgot-email");
      }
    } finally {
      setLoading(false);
    }
  }, [resetEmail, timer, resetChallengeId]);

  // ── Forgot step 3 — save new password ────────────────────────────
  const handleResetPassword = useCallback(async () => {
    if (!newPassword || !confirmPassword) {
      toast.error("Please fill in both password fields", { id: "reset-empty" });
      return;
    }
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters", {
        id: "reset-length",
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match", { id: "reset-mismatch" });
      return;
    }

    try {
      setLoading(true);
      await api.post("/auth/reset-password", { newPassword });
      toast.success("Password reset — please sign in", { id: "reset-success" });
      // Reset all state back to the login screen
      setEmail("");
      setPassword("");
      setResetEmail("");
      setNewPassword("");
      setConfirmPassword("");
      setChallengeId("");
      setResetChallengeId("");
      clearOtp();
      setStep("credentials");
    } catch (err) {
      const code = getErrorCode(err);
      toast.error(getErrorMessage(err, "Reset failed"), { id: "reset-fail" });
      if (code === "RESET_TOKEN_USED" || code === "RESET_TOKEN_INVALID") {
        setResetChallengeId("");
        clearOtp();
        setStep("forgot-email");
      }
    } finally {
      setLoading(false);
    }
  }, [newPassword, confirmPassword]);

  return {
    // ── State ────────────────────────────
    step,
    setStep,
    loading,
    email,
    setEmail,
    password,
    setPassword,
    otp,
    setOtp,
    resetEmail,
    setResetEmail,
    newPassword,
    setNewPassword,
    confirmPassword,
    setConfirmPassword,
    timer,
    formatTimer,
    // ── Handlers ─────────────────────────
    handleLoginSubmit,
    handleVerifyOtp,
    handleResendOtp,
    handleForgotSubmit,
    handleVerifyResetOtp,
    handleResendResetOtp,
    handleResetPassword,
    // ── Auth ─────────────────────────────
    isInitialLoad: user.isInitialLoad,
  };
}

export type LoginFlowState = ReturnType<typeof useLoginFlow>;
