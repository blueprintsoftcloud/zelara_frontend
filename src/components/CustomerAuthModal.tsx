// src/components/CustomerAuthModal.tsx
// Modal for customer auth with two modes:
//   Sign In:  email or phone → OTP → login  (unknown email = offer to create account)
//   Register: name + email + phone → OTP → register → auto-login

import { useState, useEffect, useCallback, useRef } from "react";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock";
import { Dialog, DialogBackdrop, DialogPanel } from "@headlessui/react";
import {
  XMarkIcon,
  ShieldExclamationIcon,
  ArrowLeftIcon,
  ClockIcon,
  ArrowPathIcon,
} from "@heroicons/react/24/outline";
import { ClipLoader } from "react-spinners";
import OtpInput from "react-otp-input";
import toast from "react-hot-toast";
import api from "../utils/api";
import { useAuth } from "../context/AuthContext";
import { useBranding } from "../context/BrandingContext";
import logo123 from "../assets/logo.png";

// ── Brand tokens ─────────────────────────────────────────────────────────────
const DEEP_GREEN = "#0c6b5e";
const EMAIL_FORMAT_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}$/;

const isValidEmailAddress = (raw: string): boolean => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 254 || !EMAIL_FORMAT_REGEX.test(trimmed)) return false;
  const [localPart, domain] = trimmed.split("@");
  if (!localPart || !domain || localPart.length > 64) return false;
  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  if (domain.split(".").some((label) => !label || label.startsWith("-") || label.endsWith("-"))) {
    return false;
  }
  return true;
};

// ── MSG91 Widget Configuration (Fetched dynamically from backend at runtime) ───
let cachedMsg91Config: { widgetId: string; tokenAuth: string } | null = null;
let pendingConfigPromise: Promise<{ widgetId: string; tokenAuth: string }> | null = null;

const fetchMsg91Config = async (): Promise<{ widgetId: string; tokenAuth: string }> => {
  if (cachedMsg91Config && cachedMsg91Config.widgetId && cachedMsg91Config.tokenAuth) {
    return cachedMsg91Config;
  }
  if (pendingConfigPromise) {
    return pendingConfigPromise;
  }
  pendingConfigPromise = api
    .get("/auth/mobile/widget-config")
    .then((res) => {
      cachedMsg91Config = {
        widgetId: res.data?.widgetId || (import.meta.env.VITE_MSG91_WIDGET_ID as string) || "",
        tokenAuth: res.data?.tokenAuth || (import.meta.env.VITE_MSG91_TOKEN_AUTH as string) || "",
      };
      return cachedMsg91Config;
    })
    .catch((err) => {
      console.warn("Could not fetch MSG91 config from backend, using env fallback", err);
      return {
        widgetId: (import.meta.env.VITE_MSG91_WIDGET_ID as string) || "",
        tokenAuth: (import.meta.env.VITE_MSG91_TOKEN_AUTH as string) || "",
      };
    })
    .finally(() => {
      pendingConfigPromise = null;
    });

  return pendingConfigPromise;
};

// ── Types ─────────────────────────────────────────────────────────────────────
type Mode = "sign-in" | "register";
type Step = "form" | "otp";

// ── OTP input style ───────────────────────────────────────────────────────────
const OTP_CLASS_4 =
  "!w-11 !h-12 sm:!w-12 sm:!h-13 border border-slate-200 sm:border-slate-300 rounded-xl sm:rounded-2xl text-center " +
  "text-xl font-bold text-slate-800 bg-white focus:outline-none " +
  "focus:border-[var(--theme-primary,#0c6b5e)] focus:ring-1 focus:ring-[var(--theme-primary,#0c6b5e)] transition-all duration-150";

const OTP_CLASS_6 =
  "!w-9 !h-11 sm:!w-10 sm:!h-12 border border-slate-200 sm:border-slate-300 rounded-xl text-center " +
  "text-lg font-bold text-slate-800 bg-white focus:outline-none " +
  "focus:border-[var(--theme-primary,#0c6b5e)] focus:ring-1 focus:ring-[var(--theme-primary,#0c6b5e)] transition-all duration-150";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function CustomerAuthModal({ open, onClose }: Props) {
  const { checkAuthStatus } = useAuth();
  const { branding } = useBranding();
  const domainUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";
  const logoSrc = branding.companyLogo
    ? branding.companyLogo.startsWith("http")
      ? branding.companyLogo
      : `${domainUrl}/${branding.companyLogo}`
    : logo123;
  const companyDisplayName = branding.companyName?.trim() || "Panakkal Ayurveda";

  useBodyScrollLock(open);

  const [mode, setMode] = useState<Mode>("sign-in");
  const [step, setStep] = useState<Step>("form");
  const [loading, setLoading] = useState(false);
  const [takingLong, setTakingLong] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const [customerEmailOtpEnabled, setCustomerEmailOtpEnabled] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  // Form fields
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  // Inline validation errors
  const [nameError, setNameError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [phoneError, setPhoneError] = useState("");

  // Blocked state — set when the entered phone/email belongs to an admin account
  const [adminBlocked, setAdminBlocked] = useState(false);

  // OTP
  const [otp, setOtp] = useState("");
  const [reqId, setReqId] = useState("");
  const [emailChallengeId, setEmailChallengeId] = useState("");
  const [challengeDead, setChallengeDead] = useState(false);
  const [timer, setTimer] = useState(0);

  // Refs for request cancellation & Enter key focus navigation
  const emailRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isVerifyingRef = useRef(false);
  const takingLongTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTakingLongTimer = () => {
    if (takingLongTimerRef.current) {
      clearTimeout(takingLongTimerRef.current);
      takingLongTimerRef.current = null;
    }
  };

  // Fetch customer auth feature flags (and MSG91 config only if SMS fallback active) on modal open
  useEffect(() => {
    if (!open) return;
    let active = true;
    setConfigLoaded(false);
    api
      .get<{ customerEmailOtpEnabled?: boolean }>("/auth/customer/config")
      .then((res) => {
        if (!active) return;
        const emailOtp = Boolean(res.data?.customerEmailOtpEnabled);
        setCustomerEmailOtpEnabled(emailOtp);
        setConfigLoaded(true);
        if (!emailOtp) {
          fetchMsg91Config();
        }
      })
      .catch(() => {
        if (!active) return;
        setCustomerEmailOtpEnabled(false);
        setConfigLoaded(true);
        fetchMsg91Config();
      });

    return () => {
      active = false;
    };
  }, [open]);

  // Clean up timers & abort requests on unmount
  useEffect(() => {
    return () => {
      clearTakingLongTimer();
      abortControllerRef.current?.abort();
    };
  }, []);

  // ── Timer countdown ────────────────────────────────────────────────────────
  useEffect(() => {
    if (timer <= 0) return;
    const id = setInterval(() => setTimer((t) => t - 1), 1000);
    return () => clearInterval(id);
  }, [timer]);

  const formatTimer = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  // ── Reset state ────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    clearTakingLongTimer();
    setStep("form");
    setPhone("");
    setName("");
    setEmail("");
    setOtp("");
    setReqId("");
    setEmailChallengeId("");
    setChallengeDead(false);
    setTimer(0);
    setNameError("");
    setEmailError("");
    setPhoneError("");
    setVerifyError("");
    setTakingLong(false);
    setAdminBlocked(false);
    isVerifyingRef.current = false;
  }, []);

  const handleClose = () => { reset(); onClose(); };

  const switchMode = (m: Mode) => { reset(); setMode(m); };

  // ── Cancel ongoing verification ────────────────────────────────────────────
  const handleCancelVerification = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    clearTakingLongTimer();
    setLoading(false);
    setTakingLong(false);
    isVerifyingRef.current = false;
    setVerifyError("Verification cancelled. Please enter the OTP again or click Resend.");
    toast("Verification stopped. You can retry.", { icon: "ℹ️", id: "verify-cancelled" });
  }, []);

  // ── Identity validation helpers ─────────────────────────────────────────────
  const validateName = (value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed) {
      setNameError("Full name is required");
      return false;
    }
    if (trimmed.length < 2) {
      setNameError("Full name must be at least 2 characters");
      return false;
    }
    if (trimmed.length > 80) {
      setNameError("Full name must be at most 80 characters");
      return false;
    }
    setNameError("");
    return true;
  };

  const handleNameChange = (raw: string) => {
    setName(raw);
    if (nameError && raw.trim().length >= 2 && raw.trim().length <= 80) {
      setNameError("");
    }
  };

  const validateEmail = (value: string): boolean => {
    if (value.trim().length === 0) {
      setEmailError("Email address is required");
      return false;
    }
    if (!isValidEmailAddress(value)) {
      setEmailError("Enter a valid email address");
      return false;
    }
    setEmailError("");
    return true;
  };

  const handleEmailChange = (raw: string) => {
    const cleaned = raw.toLowerCase();
    setEmail(cleaned);
    if (emailError) {
      setEmailError("");
    }
  };

  // ── Phone validation helper ─────────────────────────────────────────────────
  const validatePhone = (value: string): boolean => {
    if (value.trim().length === 0) {
      setPhoneError("Mobile number is required");
      return false;
    }
    if (value.trim().length !== 8) {
      setPhoneError("Qatar mobile number must be exactly 8 digits");
      return false;
    }
    if (!/^[3-7][0-9]{7}$/.test(value.trim()) && !/^[0-9]{8}$/.test(value.trim())) {
      setPhoneError("Enter a valid Qatar mobile number (8 digits)");
      return false;
    }
    setPhoneError("");
    return true;
  };

  const handlePhoneChange = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    setPhone(digits);
    if (phoneError) {
      setPhoneError("");
    }
  };

  // ── MSG91 browser call with timeout protection ──────────────────────────────
  const callMsg91 = async (
    endpoint: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 15000,
  ) => {
    const config = await fetchMsg91Config();
    const internalController = new AbortController();
    const timerId = setTimeout(() => {
      internalController.abort();
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timerId);
        return { type: "error", message: "Request cancelled." };
      }
      signal.addEventListener("abort", () => internalController.abort(), { once: true });
    }

    try {
      const r = await fetch(`https://control.msg91.com/api/v5/widget/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenAuth: config.tokenAuth, widgetId: config.widgetId, ...body }),
        signal: internalController.signal,
      });
      clearTimeout(timerId);
      const text = await r.text();
      try {
        return JSON.parse(text) as { type: string; message?: string; [k: string]: unknown };
      } catch {
        return { type: "error", message: text };
      }
    } catch (err: unknown) {
      clearTimeout(timerId);
      const e = err as Error;
      if (e?.name === "AbortError" || internalController.signal.aborted || signal?.aborted) {
        return {
          type: "error",
          message: "Verification timed out due to slow network. Please try again or request a new OTP.",
        };
      }
      return { type: "error", message: e?.message || "Network error. Please try again." };
    }
  };

  // ── Step 1: Validate form + send OTP ──────────────────────────────────────
  const handleSendOtp = async () => {
    if (!configLoaded) return;

    if (customerEmailOtpEnabled) {
      if (mode === "register") {
        const nameOk = validateName(name);
        const emailOk = validateEmail(email);
        const phoneOk = validatePhone(phone);
        if (!nameOk || !emailOk || !phoneOk) {
          if (!nameOk) toast.error("Enter your full name (at least 2 characters)", { id: "name-invalid" });
          else if (!emailOk) toast.error("Enter a valid email address", { id: "email-invalid" });
          else if (!phoneOk) toast.error("Enter a valid 8-digit Qatar mobile number", { id: "phone-invalid" });
          return;
        }
      } else if (!validateEmail(email)) {
        toast.error("Enter a valid email address", { id: "email-invalid" });
        return;
      }

      try {
        setLoading(true);
        const endpoint =
          mode === "register"
            ? "/auth/customer/signup/request-otp"
            : "/auth/customer/login/request-otp";
        const payload =
          mode === "register"
            ? { name: name.trim(), email: email.trim().toLowerCase(), phone: phone.trim() }
            : { email: email.trim().toLowerCase() };

        const res = await api.post<{
          message?: string;
          challengeId?: string;
          resendAfterSeconds?: number;
        }>(endpoint, payload, { timeout: 15000 });

        setEmailChallengeId(res.data?.challengeId ?? "");
        setChallengeDead(false);
        setOtp("");
        setVerifyError("");
        setStep("otp");
        setTimer(res.data?.resendAfterSeconds ?? 120);
        toast.success(
          res.data?.message || "Verification code sent to your email!",
          { id: "otp-sent" },
        );
      } catch (err: unknown) {
        const e = err as {
          response?: {
            data?: {
              message?: string;
              code?: string;
              retryAfterSeconds?: number;
              errors?: Record<string, string[] | undefined>;
            };
          };
        };
        const code = e?.response?.data?.code;
        if (code === "FEATURE_DISABLED") {
          setCustomerEmailOtpEnabled(false);
          fetchMsg91Config();
          toast.error("Email sign-in is disabled. Switched to mobile sign-in.", {
            id: "otp-feature-disabled",
          });
          return;
        }
        if (code === "CUSTOMER_NOT_FOUND" && mode === "sign-in") {
          setMode("register");
          setStep("form");
          setName("");
          setPhone("");
          setNameError("");
          setPhoneError("");
          setEmailError("");
          setOtp("");
          setEmailChallengeId("");
          setChallengeDead(false);
          setTimer(0);
          setVerifyError("");
          toast("No customer account found. Please create an account.", {
            icon: "ℹ️",
            id: "customer-signup-required",
          });
          return;
        }
        if (code === "ROLE_RESTRICTED") {
          setAdminBlocked(true);
          return;
        }
        if (code === "EMAIL_ALREADY_EXISTS") {
          const msg =
            e?.response?.data?.message ||
            "An account with this email address already exists. Please sign in instead.";
          setEmailError(msg);
          toast.error(msg, { id: "signup-email-exists" });
          return;
        }
        if (code === "PHONE_ALREADY_EXISTS") {
          const msg =
            e?.response?.data?.message ||
            "An account with this mobile number already exists. Please sign in instead.";
          setPhoneError(msg);
          toast.error(msg, { id: "signup-phone-exists" });
          return;
        }
        if (code === "EMAIL_AND_PHONE_ALREADY_EXISTS") {
          const msg =
            e?.response?.data?.message ||
            "An account with this email and mobile number already exists. Please sign in instead.";
          setEmailError("This email is already registered.");
          setPhoneError("This mobile number is already registered.");
          toast.error(msg, { id: "signup-account-exists" });
          return;
        }
        if (code === "SIGNUP_CONFLICT") {
          const msg =
            e?.response?.data?.message ||
            "An account with these details already exists. Please sign in instead.";
          toast.error(msg, { id: "signup-conflict" });
          return;
        }
        const fieldErrors = e?.response?.data?.errors;
        const firstFieldError = fieldErrors
          ? Object.values(fieldErrors).flat().find((item): item is string => Boolean(item))
          : undefined;
        const retryAfter = e?.response?.data?.retryAfterSeconds;
        if (retryAfter) setTimer(retryAfter);
        toast.error(firstFieldError ?? e?.response?.data?.message ?? "Failed to send verification code.", {
          id: "otp-fail",
        });
      } finally {
        setLoading(false);
      }
      return;
    }

    // PR 1 preserved MSG91 SMS Widget flow (while feature flag is off)
    if (mode === "register") {
      const nameOk = validateName(name);
      const emailOk = validateEmail(email);
      const phoneOk = validatePhone(phone);
      if (!nameOk || !emailOk || !phoneOk) {
        if (!nameOk) toast.error("Enter your full name (at least 2 characters)", { id: "name-invalid" });
        else if (!emailOk) toast.error("Enter a valid email address", { id: "email-invalid" });
        else if (!phoneOk) toast.error("Enter a valid 8-digit Qatar mobile number", { id: "phone-invalid" });
        return;
      }
    } else if (!validatePhone(phone)) {
      return;
    }
    try {
      setLoading(true);

      const data = await callMsg91("sendOtp", { identifier: `974${phone.trim()}` }, undefined, 15000);
      if (data.type !== "success") {
        toast.error(data.message ?? "Failed to send OTP", { id: "otp-fail" });
        return;
      }
      // MSG91 sendOtp returns the reqId in data.message
      setReqId((data.message ?? "") as string);
      toast.success("OTP sent to your mobile!", { id: "otp-sent" });
      setOtp("");
      setVerifyError("");
      setStep("otp");
      setTimer(120); // 2 minutes resend cooldown
    } catch {
      toast.error("Failed to send OTP. Check your connection.", { id: "otp-fail" });
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2: Verify OTP → call backend login or register ───────────────────
  const handleVerifyOtp = async (customOtp?: string) => {
    const targetOtp = (customOtp ?? otp).trim();
    const expectedDigits = customerEmailOtpEnabled ? 6 : 4;
    if (targetOtp.length !== expectedDigits) {
      toast.error(`Enter the complete ${expectedDigits}-digit OTP`, { id: "otp-incomplete" });
      return;
    }

    if (customerEmailOtpEnabled && (challengeDead || !emailChallengeId)) {
      const deadMsg = "Your verification session is no longer active. Please request a new code.";
      setVerifyError(deadMsg);
      toast.error(deadMsg, { id: "otp-session-dead" });
      return;
    }

    if (isVerifyingRef.current) return;
    isVerifyingRef.current = true;

    // Cancel prior pending verification if any
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setVerifyError("");
    setLoading(true);
    setTakingLong(false);

    // If verification takes longer than 4.5s, surface helpful feedback + cancel option
    clearTakingLongTimer();
    takingLongTimerRef.current = setTimeout(() => {
      setTakingLong(true);
    }, 4500);

    try {
      if (customerEmailOtpEnabled) {
        const endpoint =
          mode === "sign-in"
            ? "/auth/customer/login/verify-otp"
            : "/auth/customer/signup/verify-otp";
        const res = await api.post(
          endpoint,
          {
            email: email.trim().toLowerCase(),
            challengeId: emailChallengeId,
            otp: targetOtp,
          },
          { signal: controller.signal, timeout: 15000 },
        );
        toast.success(
          res.data?.message ?? (mode === "sign-in" ? "Welcome back!" : "Account created! Welcome."),
          { id: mode === "sign-in" ? "login-ok" : "register-ok" },
        );
        await checkAuthStatus();
        handleClose();
        return;
      }

      // PR 1 preserved MSG91 SMS flow
      const verifyData = await callMsg91("verifyOtp", { reqId, otp: targetOtp }, controller.signal, 15000);

      if (controller.signal.aborted) return;

      if (verifyData.type !== "success") {
        const errorMsg = verifyData.message ?? "Invalid or expired OTP";
        setVerifyError(errorMsg);
        toast.error(errorMsg, { id: "otp-verify-fail" });
        return;
      }
      const accessToken = (verifyData.message ?? "") as string;
      if (!accessToken) {
        const missingTokenMsg = "Verification token missing. Please request a new OTP.";
        setVerifyError(missingTokenMsg);
        toast.error(missingTokenMsg, { id: "otp-no-token" });
        return;
      }

      if (mode === "sign-in") {
        const res = await api.post(
          "/auth/mobile/login",
          { phone: phone.trim(), accessToken },
          { signal: controller.signal, timeout: 15000 }
        );
        toast.success(res.data.message ?? "Welcome back!", { id: "login-ok" });
        await checkAuthStatus();
        handleClose();
      } else {
        const res = await api.post(
          "/auth/mobile/register",
          {
            name: name.trim(),
            email: email.trim().toLowerCase(),
            phone: phone.trim(),
            accessToken,
          },
          { signal: controller.signal, timeout: 15000 }
        );
        toast.success(res.data.message ?? "Account created! Welcome.", { id: "register-ok" });
        await checkAuthStatus();
        handleClose();
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      const e = err as {
        response?: {
          data?: {
            message?: string;
            code?: string;
            errors?: Record<string, string[] | undefined>;
          };
        };
        code?: string;
        message?: string;
      };
      const fieldErrors = e?.response?.data?.errors;
      const firstFieldError = fieldErrors
        ? Object.values(fieldErrors).flat().find((item): item is string => Boolean(item))
        : undefined;
      const msg = firstFieldError ?? e?.response?.data?.message;
      const code = e?.response?.data?.code;

      if (code === "NO_ACCOUNT") {
        const savedPhone = phone;
        toast.error("No account found. Please create an account.", { id: "no-account", duration: 4000 });
        reset();
        setMode("register");
        setPhone(savedPhone);
      } else if (code === "DUPLICATE") {
        toast.error("Account already exists. Please sign in instead.", { id: "duplicate", duration: 4000 });
        const savedPhone = phone;
        reset();
        setMode("sign-in");
        setPhone(savedPhone);
      } else if (code === "ROLE_RESTRICTED") {
        reset();
        setAdminBlocked(true);
      } else if (code === "FEATURE_DISABLED") {
        reset();
        setCustomerEmailOtpEnabled(false);
        fetchMsg91Config();
        toast.error("Email sign-in is disabled. Switched to mobile sign-in.", {
          id: "otp-feature-disabled",
        });
      } else if (
        code === "CHALLENGE_LOCKED" ||
        code === "CHALLENGE_EXPIRED" ||
        code === "CHALLENGE_CONSUMED" ||
        code === "CHALLENGE_INVALID" ||
        code === "CHALLENGE_MISSING" ||
        code === "SIGNUP_CONFLICT" ||
        code === "EMAIL_NOT_VERIFIED" ||
        code === "ACCOUNT_DEACTIVATED"
      ) {
        const terminalMsg = msg ?? "Verification session expired. Please request a new code.";
        setChallengeDead(true);
        setEmailChallengeId("");
        setOtp("");
        setVerifyError(terminalMsg);
        toast.error(terminalMsg, { id: "otp-verify-terminal" });
      } else if (e?.code === "ECONNABORTED" || e?.message?.includes("timeout")) {
        const timeoutMsg = "Verification timed out. Please check your connection and try again.";
        setVerifyError(timeoutMsg);
        toast.error(timeoutMsg, { id: "otp-verify-timeout" });
      } else {
        const fallbackMsg = msg ?? "Something went wrong. Please try again.";
        if (customerEmailOtpEnabled) setOtp("");
        setVerifyError(fallbackMsg);
        toast.error(fallbackMsg, { id: "otp-verify-fail" });
      }
    } finally {
      clearTakingLongTimer();
      setTakingLong(false);
      setLoading(false);
      isVerifyingRef.current = false;
      abortControllerRef.current = null;
    }
  };

  // ── Resend OTP ─────────────────────────────────────────────────────────────
  const handleResend = async () => {
    if (timer > 0) return;

    if (customerEmailOtpEnabled) {
      if (challengeDead || !emailChallengeId) {
        setStep("form");
        setOtp("");
        setVerifyError("");
        setChallengeDead(false);
        return;
      }

      try {
        setLoading(true);
        setVerifyError("");
        const endpoint =
          mode === "register"
            ? "/auth/customer/signup/resend-otp"
            : "/auth/customer/login/resend-otp";
        const res = await api.post<{
          message?: string;
          challengeId?: string;
          resendAfterSeconds?: number;
        }>(
          endpoint,
          { email: email.trim().toLowerCase(), challengeId: emailChallengeId },
          { timeout: 15000 },
        );
        if (res.data?.challengeId) {
          setEmailChallengeId(res.data.challengeId);
        }
        setChallengeDead(false);
        setOtp("");
        setTimer(res.data?.resendAfterSeconds ?? 120);
        toast.success("Verification code resent!", { id: "otp-resent" });
      } catch (err: unknown) {
        const e = err as {
          response?: {
            data?: { message?: string; code?: string; retryAfterSeconds?: number };
          };
        };
        const code = e?.response?.data?.code;
        if (code === "FEATURE_DISABLED") {
          reset();
          setCustomerEmailOtpEnabled(false);
          fetchMsg91Config();
          toast.error("Email sign-in is disabled. Switched to mobile sign-in.", {
            id: "otp-feature-disabled",
          });
          return;
        }
        const msg = e?.response?.data?.message ?? "Failed to resend code.";
        if (code === "RESEND_COOLDOWN" && e?.response?.data?.retryAfterSeconds) {
          setTimer(e.response.data.retryAfterSeconds);
        } else if (
          code === "CHALLENGE_LOCKED" ||
          code === "CHALLENGE_EXPIRED" ||
          code === "CHALLENGE_CONSUMED" ||
          code === "CHALLENGE_INVALID" ||
          code === "CHALLENGE_MISSING" ||
          code === "MAX_RESENDS_EXCEEDED"
        ) {
          setChallengeDead(true);
          setEmailChallengeId("");
        }
        setVerifyError(msg);
        toast.error(msg, { id: "resend-fail" });
      } finally {
        setLoading(false);
      }
      return;
    }

    // PR 1 preserved MSG91 retry
    try {
      setLoading(true);
      setVerifyError("");
      const data = await callMsg91("retryOtp", { reqId }, undefined, 10000);
      if (data.type !== "success") {
        toast.error(data.message ?? "Failed to resend OTP", { id: "resend-fail" });
        return;
      }
      if (data.message) setReqId(data.message as string);
      toast.success("OTP resent!", { id: "otp-resent" });
      setOtp("");
      setTimer(120); // 2 minutes resend cooldown
    } catch {
      toast.error("Failed to resend OTP.", { id: "resend-fail" });
    } finally {
      setLoading(false);
    }
  };

  // ── Handle OTP input change with auto-submit ──────────────────────────────
  const handleOtpChange = (value: string) => {
    const expectedDigits = customerEmailOtpEnabled ? 6 : 4;
    const digits = value.replace(/\D/g, "").slice(0, expectedDigits);
    setOtp(digits);
    if (verifyError) setVerifyError("");

    // Auto-verify when all expected digits are completed
    if (digits.length === expectedDigits && !loading && !isVerifyingRef.current && !challengeDead) {
      setTimeout(() => {
        handleVerifyOtp(digits);
      }, 50);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const expectedOtpLength = customerEmailOtpEnabled ? 6 : 4;
  const subtitle =
    mode === "sign-in"
      ? customerEmailOtpEnabled
        ? "Enter your registered email address to continue"
        : "Enter your registered mobile number to proceed"
      : customerEmailOtpEnabled
        ? "We'll send a 6-digit verification code to your email address"
        : "Sign up with your details to start shopping";

  return (
    <Dialog open={open} onClose={handleClose} className="relative z-[100]">
      <DialogBackdrop className="fixed inset-0 bg-slate-950/50 backdrop-blur-xs transition-opacity duration-300 animate-in fade-in" />

      <div className="fixed inset-0 flex items-center justify-center p-3 sm:p-4">
        <DialogPanel className="w-full max-w-[360px] xs:max-w-[390px] sm:max-w-[620px] bg-white rounded-[26px] sm:rounded-[28px] shadow-2xl border border-slate-100 relative overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col sm:flex-row items-stretch">
          {/* Desktop Close Button */}
          <button
            type="button"
            onClick={handleClose}
            className="hidden sm:block absolute top-4 right-4 sm:top-5 sm:right-5 p-1 text-slate-400 hover:text-slate-600 transition-colors z-20 cursor-pointer"
            aria-label="Close"
          >
            <XMarkIcon className="h-5 w-5" strokeWidth={2.2} />
          </button>

          {/* Left Column: Branding Logo & Name (Desktop only) */}
          <div className="hidden sm:flex sm:w-[210px] md:w-[230px] bg-[#f8faff] flex-col items-center justify-center p-6 sm:p-7 text-center select-none border-r border-slate-100 shrink-0">
            <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-full p-1 bg-white ring-2 ring-[#eedc9e] shadow-xs flex items-center justify-center overflow-hidden">
              <img
                src={logoSrc}
                alt={companyDisplayName}
                className="w-full h-full object-contain rounded-full"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = logo123;
                }}
              />
            </div>
            <h3 className="mt-4 font-serif font-bold text-slate-800 text-base sm:text-lg leading-tight px-2">
              {companyDisplayName}
            </h3>
            <p className="mt-1 text-xs text-slate-400 font-medium">Fast & Secure Login</p>
          </div>

          {/* Right Column: Auth Content */}
          <div className="flex-1 min-w-0 p-5 sm:p-7 md:p-8 flex flex-col justify-center bg-white relative">
            {/* Mobile Header: Logo + Store Name + Subtitle + Close Button (Matches referral image) */}
            <div className="flex sm:hidden items-start justify-between mb-5">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-11 h-11 rounded-full p-0.5 bg-white ring-2 ring-[#eedc9e] shadow-xs flex items-center justify-center overflow-hidden shrink-0">
                  <img
                    src={logoSrc}
                    alt={companyDisplayName}
                    className="w-full h-full object-contain rounded-full"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = logo123;
                    }}
                  />
                </div>
                <div className="min-w-0 text-left">
                  <h3 className="font-serif font-bold text-slate-900 text-[15px] leading-tight truncate">
                    {companyDisplayName}
                  </h3>
                  <p className="text-xs text-slate-400 font-medium mt-0.5">
                    Fast & Secure Login
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="p-1 text-slate-400 hover:text-slate-600 transition-colors shrink-0 cursor-pointer -mr-1 -mt-1"
                aria-label="Close"
              >
                <XMarkIcon className="h-5 w-5" strokeWidth={2.2} />
              </button>
            </div>

            {/* ── Admin account blocked screen ──────────────────────────────── */}
            {adminBlocked ? (
              <div className="flex flex-col items-center text-center gap-3 py-2">
                <div className="w-14 h-14 rounded-2xl bg-rose-50 border border-rose-100 flex items-center justify-center shadow-inner">
                  <ShieldExclamationIcon className="w-7 h-7 text-rose-500" strokeWidth={1.8} />
                </div>

                <div>
                  <h2 className="text-lg font-black text-slate-900 tracking-tight">Access Restricted</h2>
                  <p className="text-xs text-slate-500 mt-1 leading-relaxed max-w-xs mx-auto">
                    This {customerEmailOtpEnabled ? "email address" : "mobile number"} belongs to an administrative or staff profile. Please log in through the{" "}
                    <span className="font-bold text-slate-900">Staff / Admin Portal</span>.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setAdminBlocked(false);
                    setPhone("");
                    setEmail("");
                  }}
                  className="w-full h-11 text-xs font-bold uppercase tracking-wider rounded-2xl border border-slate-200 text-slate-700 hover:bg-slate-50 transition cursor-pointer flex items-center justify-center gap-2 mt-2"
                >
                  <ArrowLeftIcon className="w-4 h-4" strokeWidth={2.2} />
                  {customerEmailOtpEnabled ? "Try a different email" : "Try a different number"}
                </button>
              </div>
            ) : !configLoaded ? (
              <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                <ClipLoader color={DEEP_GREEN} size={26} />
                <p className="text-xs font-medium text-slate-400">
                  Loading sign-in options...
                </p>
              </div>
            ) : step === "form" ? (
              <div>
                {/* Tabs: SIGN IN | CREATE ACCOUNT */}
                <div className="flex items-center gap-6 mb-2.5">
                  <button
                    type="button"
                    onClick={() => switchMode("sign-in")}
                    className={`text-xs font-bold uppercase tracking-wider pb-1 transition-all cursor-pointer ${
                      mode === "sign-in"
                        ? "text-[var(--theme-primary,#0c6b5e)] border-b-2 border-[var(--theme-primary,#0c6b5e)]"
                        : "text-slate-400 hover:text-slate-600 border-b-2 border-transparent"
                    }`}
                  >
                    SIGN IN
                  </button>
                  <button
                    type="button"
                    onClick={() => switchMode("register")}
                    className={`text-xs font-bold uppercase tracking-wider pb-1 transition-all cursor-pointer ${
                      mode === "register"
                        ? "text-[var(--theme-primary,#0c6b5e)] border-b-2 border-[var(--theme-primary,#0c6b5e)]"
                        : "text-slate-400 hover:text-slate-600 border-b-2 border-transparent"
                    }`}
                  >
                    CREATE ACCOUNT
                  </button>
                </div>

                <p className="text-xs text-slate-500 font-medium mb-4">{subtitle}</p>

                {/* SIGN IN Mode Form */}
                {mode === "sign-in" && (
                  <div className="space-y-4">
                    {customerEmailOtpEnabled ? (
                      <div className="flex flex-col gap-1">
                        <input
                          ref={emailRef}
                          type="email"
                          required
                          autoComplete="email"
                          value={email}
                          onChange={(e) => handleEmailChange(e.target.value)}
                          onBlur={() => email.length > 0 && validateEmail(email)}
                          placeholder="Enter Email Address *"
                          className={`w-full h-12 px-4 rounded-xl sm:rounded-2xl border transition-all text-sm outline-none bg-white text-slate-900 font-bold placeholder:font-normal placeholder:text-slate-400 ${
                            emailError
                              ? "border-rose-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500/20"
                              : "border-slate-200 sm:border-slate-300 focus:border-[var(--theme-primary,#0c6b5e)] focus:ring-1 focus:ring-[var(--theme-primary,#0c6b5e)]"
                          }`}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleSendOtp();
                            }
                          }}
                          autoFocus
                        />
                        {emailError && (
                          <p className="text-[11px] text-rose-500 font-semibold flex items-center gap-1 mt-0.5 pl-1 animate-fadeIn">
                            <ShieldExclamationIcon className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
                            {emailError}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2 sm:gap-2.5">
                          <div className="w-14 sm:w-16 h-12 flex items-center justify-center rounded-xl sm:rounded-2xl border border-slate-200 sm:border-slate-300 text-slate-800 font-bold text-sm bg-white shrink-0">
                            +974
                          </div>
                          <input
                            ref={phoneRef}
                            type="tel"
                            inputMode="numeric"
                            maxLength={8}
                            value={phone}
                            onChange={(e) => handlePhoneChange(e.target.value)}
                            onBlur={() => phone.length > 0 && validatePhone(phone)}
                            placeholder="Enter Mobile Number"
                            className={`flex-1 min-w-0 h-12 px-4 rounded-xl sm:rounded-2xl border transition-all text-sm outline-none bg-white text-slate-900 placeholder:text-slate-400 placeholder:font-normal font-bold tracking-wide ${
                              phoneError
                                ? "border-rose-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500/20"
                                : "border-slate-200 sm:border-slate-300 focus:border-[var(--theme-primary,#0c6b5e)] focus:ring-1 focus:ring-[var(--theme-primary,#0c6b5e)]"
                            }`}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleSendOtp();
                              }
                            }}
                            autoFocus
                          />
                        </div>
                        {phoneError && (
                          <p className="text-[11px] text-rose-500 font-semibold flex items-center gap-1 mt-0.5 pl-1 animate-fadeIn">
                            <ShieldExclamationIcon className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
                            {phoneError}
                          </p>
                        )}
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={handleSendOtp}
                      disabled={loading || !configLoaded}
                      className="w-full h-12 bg-[var(--theme-primary,#0c6b5e)] hover:bg-[var(--theme-primary-hover,#09574c)] text-[var(--theme-primary-ink,#ffffff)] active:scale-[0.99] font-bold text-sm rounded-xl sm:rounded-2xl transition-all duration-150 cursor-pointer flex items-center justify-center disabled:opacity-60 shadow-none mt-2"
                    >
                      {loading ? (
                        <ClipLoader color="currentColor" size={18} />
                      ) : customerEmailOtpEnabled ? (
                        "Continue with Email"
                      ) : (
                        "Submit"
                      )}
                    </button>
                  </div>
                )}

                {/* CREATE ACCOUNT Mode Form */}
                {mode === "register" && (
                  <div className="space-y-3 sm:space-y-3.5">
                    {/* Full Name */}
                    <div className="flex flex-col gap-1">
                      <input
                        type="text"
                        required
                        value={name}
                        onChange={(e) => handleNameChange(e.target.value)}
                        onBlur={() => name.length > 0 && validateName(name)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            emailRef.current?.focus();
                          }
                        }}
                        placeholder="Enter Full Name *"
                        className={`w-full h-12 px-4 rounded-xl sm:rounded-2xl border transition-all text-sm outline-none bg-white text-slate-900 font-bold placeholder:font-normal placeholder:text-slate-400 ${
                          nameError
                            ? "border-rose-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500/20"
                            : "border-slate-200 sm:border-slate-300 focus:border-[var(--theme-primary,#0c6b5e)] focus:ring-1 focus:ring-[var(--theme-primary,#0c6b5e)]"
                        }`}
                        autoFocus
                      />
                      {nameError && (
                        <p className="text-[11px] text-rose-500 font-semibold flex items-center gap-1 mt-0.5 pl-1 animate-fadeIn">
                          <ShieldExclamationIcon className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
                          {nameError}
                        </p>
                      )}
                    </div>

                    {/* Email */}
                    <div className="flex flex-col gap-1">
                      <input
                        ref={emailRef}
                        type="email"
                        required
                        autoComplete="email"
                        value={email}
                        onChange={(e) => handleEmailChange(e.target.value)}
                        onBlur={() => email.length > 0 && validateEmail(email)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            phoneRef.current?.focus();
                          }
                        }}
                        placeholder="Enter Email Address *"
                        className={`w-full h-12 px-4 rounded-xl sm:rounded-2xl border transition-all text-sm outline-none bg-white text-slate-900 font-bold placeholder:font-normal placeholder:text-slate-400 ${
                          emailError
                            ? "border-rose-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500/20"
                            : "border-slate-200 sm:border-slate-300 focus:border-[var(--theme-primary,#0c6b5e)] focus:ring-1 focus:ring-[var(--theme-primary,#0c6b5e)]"
                        }`}
                      />
                      {emailError && (
                        <p className="text-[11px] text-rose-500 font-semibold flex items-center gap-1 mt-0.5 pl-1 animate-fadeIn">
                          <ShieldExclamationIcon className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
                          {emailError}
                        </p>
                      )}
                    </div>

                    {/* Mobile Number */}
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2 sm:gap-2.5">
                        <div className="w-14 sm:w-16 h-12 flex items-center justify-center rounded-xl sm:rounded-2xl border border-slate-200 sm:border-slate-300 text-slate-800 font-bold text-sm bg-white shrink-0">
                          +974
                        </div>
                        <input
                          ref={phoneRef}
                          type="tel"
                          required
                          inputMode="numeric"
                          maxLength={8}
                          value={phone}
                          onChange={(e) => handlePhoneChange(e.target.value)}
                          onBlur={() => phone.length > 0 && validatePhone(phone)}
                          placeholder="Enter Mobile Number *"
                          className={`flex-1 min-w-0 h-12 px-4 rounded-xl sm:rounded-2xl border transition-all text-sm outline-none bg-white text-slate-900 placeholder:text-slate-400 placeholder:font-normal font-bold tracking-wide ${
                            phoneError
                              ? "border-rose-400 focus:border-rose-500 focus:ring-1 focus:ring-rose-500/20"
                              : "border-slate-200 sm:border-slate-300 focus:border-[var(--theme-primary,#0c6b5e)] focus:ring-1 focus:ring-[var(--theme-primary,#0c6b5e)]"
                          }`}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleSendOtp();
                            }
                          }}
                        />
                      </div>
                      {phoneError && (
                        <p className="text-[11px] text-rose-500 font-semibold flex items-center gap-1 mt-0.5 pl-1 animate-fadeIn">
                          <ShieldExclamationIcon className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
                          {phoneError}
                        </p>
                      )}
                    </div>

                    {/* Submit button */}
                    <button
                      type="button"
                      onClick={handleSendOtp}
                      disabled={loading || !configLoaded}
                      className="w-full h-12 bg-[var(--theme-primary,#0c6b5e)] hover:bg-[var(--theme-primary-hover,#09574c)] text-[var(--theme-primary-ink,#ffffff)] active:scale-[0.99] font-bold text-sm rounded-xl sm:rounded-2xl transition-all duration-150 cursor-pointer flex items-center justify-center disabled:opacity-60 shadow-none mt-1"
                    >
                      {loading ? (
                        <ClipLoader color="currentColor" size={18} />
                      ) : customerEmailOtpEnabled ? (
                        "Continue with Email"
                      ) : (
                        "Submit"
                      )}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              /* ── Step 2: OTP Step ── */
              <div className="space-y-4">
                <div className="flex items-center gap-6 mb-2">
                  <span className="text-[var(--theme-primary,#0c6b5e)] font-bold text-xs uppercase tracking-wider pb-1 border-b-2 border-[var(--theme-primary,#0c6b5e)]">
                    VERIFY OTP
                  </span>
                </div>

                <p className="text-xs text-slate-500 font-medium">
                  {customerEmailOtpEnabled ? (
                    <>
                      Enter the 6-digit code sent to <span className="font-bold text-slate-800">{email}</span>
                    </>
                  ) : (
                    <>
                      Enter the 4-digit code sent to +974 <span className="font-bold text-slate-800">{phone}</span>
                    </>
                  )}
                </p>

                {customerEmailOtpEnabled && (
                  <p className="text-[11px] text-slate-400">
                    Delivery may take a few seconds. Please check your inbox or spam folder.
                  </p>
                )}

                <OtpInput
                  value={otp}
                  onChange={handleOtpChange}
                  numInputs={expectedOtpLength}
                  shouldAutoFocus
                  renderInput={(props) => (
                    <input
                      {...props}
                      disabled={loading || challengeDead}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      className={`${customerEmailOtpEnabled ? OTP_CLASS_6 : OTP_CLASS_4} ${loading || challengeDead ? "opacity-60 bg-slate-50 cursor-not-allowed" : ""}`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && otp.length === expectedOtpLength && !loading && !challengeDead) {
                          e.preventDefault();
                          handleVerifyOtp(otp);
                        }
                        if (props.onKeyDown) props.onKeyDown(e);
                      }}
                    />
                  )}
                  containerStyle={{
                    width: "100%",
                    display: "flex",
                    justifyContent: "center",
                    gap: customerEmailOtpEnabled ? "6px" : "10px",
                  }}
                />

                {/* Inline error alert */}
                {verifyError && (
                  <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-100 flex flex-col gap-2 text-xs text-rose-700 animate-fadeIn">
                    <div className="flex items-start gap-2">
                      <ShieldExclamationIcon className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" strokeWidth={2} />
                      <p className="font-semibold leading-relaxed">{verifyError}</p>
                    </div>
                    {challengeDead && (
                      <button
                        type="button"
                        onClick={() => {
                          setStep("form");
                          setOtp("");
                          setVerifyError("");
                          setEmailChallengeId("");
                          setChallengeDead(false);
                        }}
                        className="self-start text-[11px] font-bold underline text-rose-800 hover:text-rose-950 cursor-pointer"
                      >
                        Request a new verification code
                      </button>
                    )}
                  </div>
                )}

                {/* Taking long warning */}
                {loading && takingLong && (
                  <div className="p-2.5 rounded-xl bg-amber-50/90 border border-amber-200/80 flex items-center justify-between gap-2 text-xs text-amber-900 shadow-xs animate-fadeIn">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <ClockIcon className="w-4 h-4 text-amber-600 shrink-0 animate-pulse" strokeWidth={2} />
                      <span className="font-medium truncate text-[11px]">Taking longer than usual...</span>
                    </div>
                    <button
                      type="button"
                      onClick={handleCancelVerification}
                      className="font-bold text-amber-900 underline hover:text-amber-950 whitespace-nowrap cursor-pointer text-[11px]"
                    >
                      Cancel & Retry
                    </button>
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => handleVerifyOtp()}
                    disabled={loading || challengeDead || otp.length !== expectedOtpLength}
                    className="w-full h-12 bg-[var(--theme-primary,#0c6b5e)] hover:bg-[var(--theme-primary-hover,#09574c)] text-[var(--theme-primary-ink,#ffffff)] active:scale-[0.99] font-bold text-sm rounded-xl sm:rounded-2xl transition-all duration-150 cursor-pointer flex items-center justify-center disabled:opacity-60 shadow-none"
                  >
                    {loading ? (
                      <div className="flex items-center gap-2">
                        <ClipLoader color="currentColor" size={16} />
                        <span>Verifying...</span>
                      </div>
                    ) : customerEmailOtpEnabled ? (
                      "Verify OTP"
                    ) : (
                      "Submit"
                    )}
                  </button>

                  {loading && (
                    <button
                      type="button"
                      onClick={handleCancelVerification}
                      className="w-full py-1 text-xs font-semibold text-slate-500 hover:text-slate-800 transition text-center cursor-pointer"
                    >
                      Stop & Edit OTP
                    </button>
                  )}
                </div>

                <div className="flex flex-col items-center gap-2 pt-1 border-t border-slate-100">
                  <p className="text-xs text-slate-500 font-medium flex items-center gap-1.5">
                    Didn't receive the code?{" "}
                    <button
                      type="button"
                      onClick={handleResend}
                      disabled={timer > 0 || loading}
                      className="font-bold text-[var(--theme-primary,#0c6b5e)] hover:underline disabled:opacity-50 transition cursor-pointer inline-flex items-center gap-1"
                    >
                      {timer > 0 ? (
                        `Resend in ${formatTimer(timer)}`
                      ) : (
                        <>
                          <ArrowPathIcon className="w-3.5 h-3.5 inline" strokeWidth={2.2} />
                          Resend OTP
                        </>
                      )}
                    </button>
                  </p>

                  <button
                    type="button"
                    onClick={() => {
                      if (loading || isVerifyingRef.current) {
                        handleCancelVerification();
                      }
                      setStep("form");
                      setOtp("");
                      setVerifyError("");
                      setEmailChallengeId("");
                      setChallengeDead(false);
                    }}
                    disabled={loading}
                    className="text-xs font-semibold text-slate-400 hover:text-slate-700 transition flex items-center gap-1 cursor-pointer disabled:opacity-40"
                  >
                    <ArrowLeftIcon className="w-3.5 h-3.5" strokeWidth={2.2} />
                    {mode === "register"
                      ? "Edit details"
                      : customerEmailOtpEnabled
                        ? "Change email address"
                        : "Change mobile number"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
