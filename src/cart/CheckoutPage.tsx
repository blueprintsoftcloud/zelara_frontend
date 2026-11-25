import React, { useEffect, useState, useRef, Fragment } from "react";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock";
import { createPortal } from "react-dom";
import { Popover, Transition } from "@headlessui/react";
import {
  ChevronUpIcon,
  ChevronDownIcon,
  MapPinIcon,
  TruckIcon,
  CreditCardIcon,
  BanknotesIcon,
  TagIcon,
  XCircleIcon,
  LockClosedIcon,
} from "@heroicons/react/24/outline";
import { ArrowLeft, CheckCircle, Package, QrCode, UploadCloud, Copy, Trash2, X, Sparkles, AlertCircle, Smartphone, ExternalLink, Loader2 } from "lucide-react";
import QRCode from "qrcode";
import CouponCarousel from "../components/CouponCarousel";

const validateTransactionId = (val: string) => {
  const cleaned = val.trim().replace(/[\s-]/g, "");
  if (!cleaned) return { isValid: false, message: "", type: "EMPTY" };

  // Pure digits: standard NPCI 12-digit UTR
  if (/^\d+$/.test(cleaned)) {
    if (cleaned.length === 12) {
      return { isValid: true, message: "Valid 12-digit UPI UTR", type: "UTR" };
    }
    return {
      isValid: false,
      message: "UTR must be exactly 12 digits",
      type: "INCOMPLETE_UTR",
    };
  }

  // Alphanumeric UPI Reference ID (10 to 12 chars)
  if (/^[a-zA-Z0-9_-]{10,12}$/.test(cleaned)) {
    return { isValid: true, message: "Valid UPI Reference ID", type: "REF_ID" };
  }

  if (cleaned.length < 10) {
    return {
      isValid: false,
      message: "Min 10 characters or 12-digit UTR required",
      type: "TOO_SHORT",
    };
  }

  return {
    isValid: false,
    message: "Only numbers, letters, hyphens, and underscores allowed",
    type: "INVALID_CHARS",
  };
};
import { useCart } from "../context/CartContext";
import { useAuth } from "../context/AuthContext";
import { useNavigate, useLocation } from "react-router-dom";
import api from "../utils/api";
import CancellationFeedbackModal, { SurveyItemSnapshot } from "../components/CancellationFeedbackModal";
import toast, { Toaster } from "react-hot-toast";
import { trackMetaInitiateCheckout, trackMetaPurchase } from "../utils/metaPixel";

import { motion, AnimatePresence } from "framer-motion";

interface AddressState {
  house: string;
  city: string;
  state: string;
  pincode: string;
  locality?: string;
  lat: number | null;
  lng: number | null;
}

interface Suggestion {
  lat: string;
  lon: string;
  display_name: string;
}

const QATAR_MUNICIPALITIES = [
  "Doha",
  "Al Rayyan",
  "Al Wakrah",
  "Al Daayen",
  "Al Khor",
  "Umm Salal",
  "Al Shahaniya",
  "Al Shamal",
];

const CheckoutPage = () => {
  const { user } = useAuth();
  const { cartItems, cartTotal, clearCart, fetchCart } = useCart();
  const navigate = useNavigate();
  const location = useLocation();

  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [feedbackTriggerSource, setFeedbackTriggerSource] = useState("CHECKOUT_CANCELLED");
  const [feedbackOrderId, setFeedbackOrderId] = useState<string | undefined>(undefined);
  const [userProfile, setUserProfile] = useState<{
    username?: string;
    email?: string;
    phone?: string;
  } | null>(null);
  const prefill = location.state as {
    addressPrefill?: {
      fullAddress: string;
      detectedArea?: string;
      city: string;
      state: string;
      zipCode: string;
      locality?: string;
      lat: number | null;
      lng: number | null;
      isGpsLocked?: boolean;
    };
    shippingCharge?: number;
    buyNowProductId?: string;
    buyNowVariantId?: string | null;
  } | null;
  const buyNowProductId = prefill?.buyNowProductId ?? null;
  const buyNowVariantId = prefill?.buyNowVariantId ?? null;
  const isPaymentSuccess = useRef(false);

  // For Buy Now: only process the specific product, not the entire cart
  const checkoutItems = buyNowProductId
    ? cartItems.filter(
        (i) =>
          i.productId === buyNowProductId &&
          (!buyNowVariantId || (i.variantId ?? null) === buyNowVariantId),
      )
    : cartItems;
  const checkoutSubtotal = checkoutItems.reduce(
    (sum, i) => sum + i.price * i.quantity,
    0,
  );

  const [address, setAddress] = useState<AddressState>({
    house: prefill?.addressPrefill?.fullAddress ?? "",
    city: prefill?.addressPrefill?.city ?? "",
    state: prefill?.addressPrefill?.state ?? "",
    pincode: prefill?.addressPrefill?.zipCode ?? "",
    locality: prefill?.addressPrefill?.locality ?? "",
    lat: prefill?.addressPrefill?.lat ?? null,
    lng: prefill?.addressPrefill?.lng ?? null,
  });


  const [detectedArea, setDetectedArea] = useState<string>(
    prefill?.addressPrefill?.detectedArea ?? ""
  );

  const [isGpsLocked, setIsGpsLocked] = useState<boolean>(
    !!prefill?.addressPrefill?.isGpsLocked || (!!prefill?.addressPrefill?.lat && !!prefill?.addressPrefill?.lng),
  );

  const [shippingCharge, setShippingCharge] = useState(
    prefill?.shippingCharge ?? 0,
  );
  const [shippingCalculating, setShippingCalculating] = useState(false);
  const [shippingToggles, setShippingToggles] = useState<{
    calculateShippingForCOD: boolean;
    calculateShippingForOnline: boolean;
    calculateShippingForQR?: boolean;
  }>({
    calculateShippingForCOD: true,
    calculateShippingForOnline: true,
    calculateShippingForQR: false,
  });
  const SHOW_ONLINE_PAYMENT = false;
  const [paymentMethod, setPaymentMethod] = useState("POD");
  const [loading, setLoading] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  useBodyScrollLock(showSuccessModal);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  // Coupon state
  const [couponCode, setCouponCode] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<{
    couponId: string;
    code: string;
    discountAmount: number;
    discountType: string;
    discountValue: number;
  } | null>(null);
  const [couponLoading, setCouponLoading] = useState(false);

  // Dismiss any lingering toasts from previous pages on mount
  useEffect(() => {
    toast.dismiss();
  }, []);

  // Track Meta Pixel InitiateCheckout event when checkout loads with items
  useEffect(() => {
    if (checkoutItems.length > 0) {
      trackMetaInitiateCheckout({
        numItems: checkoutItems.reduce((sum, i) => sum + i.quantity, 0),
        totalValue: checkoutSubtotal,
        currency: "QAR",
      });
    }
  }, [checkoutItems.length]);

  // Pay with QR state
  const [qrConfig, setQrConfig] = useState<{
    enabled: boolean;
    qrCode: string;
    upiId?: string;
    accountName?: string;
    instructions?: string;
  }>({ enabled: false, qrCode: "" });
  const [showQrModal, setShowQrModal] = useState(false);
  const [qrModalStep, setQrModalStep] = useState<"SCAN" | "SUBMIT">("SCAN");
  const [qrViewMode, setQrViewMode] = useState<"APP" | "QR">("APP");
  useBodyScrollLock(showQrModal);
  const [dynamicQrUrl, setDynamicQrUrl] = useState<string | null>(null);
  const [qrTransactionId, setQrTransactionId] = useState("");
  const [qrScreenshotFile, setQrScreenshotFile] = useState<File | null>(null);
  const [qrScreenshotPreview, setQrScreenshotPreview] = useState<string | null>(null);
  const [qrSubmitting, setQrSubmitting] = useState(false);

  // Fetch logged in customer profile details for accurate activity tracking
  useEffect(() => {
    if (user?.isAuthenticated) {
      api
        .get("/user/profile")
        .then((res) => {
          if (res.data?.users) {
            setUserProfile(res.data.users);
          }
        })
        .catch(() => {});
    }
  }, [user?.isAuthenticated]);

  // Fetch default saved address if no prefill address was provided (e.g. direct checkout from cart)
  useEffect(() => {
    if (!prefill?.addressPrefill && user?.isAuthenticated) {
      api
        .get("/address/default")
        .then((res) => {
          const addr = res.data?.address;
          if (addr) {
            setAddress({
              house: addr.fullAddress || "",
              city: addr.city || "",
              state: addr.state || "",
              pincode: addr.zipCode || "",
              locality: addr.locality || "",
              lat: addr.latitude ?? null,
              lng: addr.longitude ?? null,
            });
            if (addr.latitude && addr.longitude) {
              setIsGpsLocked(true);
            }
          }
        })
        .catch(() => {});
    }
  }, [user?.isAuthenticated, prefill?.addressPrefill]);

  // Fetch the payment-method shipping toggles configured by the store.
  useEffect(() => {
    api.get("/order/shipping-toggles")
      .then((res) => {
        if (res.data?.toggles) {
          setShippingToggles({
            calculateShippingForCOD: res.data.toggles.calculateShippingForCOD !== false,
            calculateShippingForOnline: res.data.toggles.calculateShippingForOnline !== false,
          });
        }
      })
      .catch((err) => {
        console.error("Failed to load shipping toggles", err);
      });
  }, []);

  // Protect route: Redirect to home and open cart drawer if there are no items to checkout
  useEffect(() => {
    if (!showSuccessModal) {
      if (!buyNowProductId && (!cartItems || cartItems.length === 0)) {
        navigate("/", { replace: true });
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("open-cart-drawer"));
        }, 150);
      }
    }
  }, [cartItems, buyNowProductId, showSuccessModal, navigate]);

  // Recalculate the delivery fee whenever the manually selected municipality changes.
  useEffect(() => {
    if (isGpsLocked) return;

    if (!address.state.trim()) {
      setShippingCalculating(false);
      setShippingCharge(0);
      return;
    }

    let active = true;
    setShippingCalculating(true);
    const delayDebounce = setTimeout(async () => {
      try {
        const res = await api.post("/address/preview-shipping", {
          manual: true,
          state: address.state.trim(),
          city: address.city.trim(),
        });
        if (!active) return;
        if (typeof res.data?.shippingCharge === "number") setShippingCharge(res.data.shippingCharge);
        if (typeof res.data?.calculateShippingForCOD === "boolean") {
          setShippingToggles({
            calculateShippingForCOD: res.data.calculateShippingForCOD !== false,
            calculateShippingForOnline: res.data.calculateShippingForOnline !== false,
          });
        }
      } catch (err) {
        if (active) console.error("Error updating shipping charge", err);
      } finally {
        if (active) setShippingCalculating(false);
      }
    }, 500);

    return () => {
      active = false;
      clearTimeout(delayDebounce);
    };
  }, [address.state, address.city, isGpsLocked]);

  // Re-verify shipping charge when GPS is locked to ensure rates from DB are fresh
  useEffect(() => {
    if (!isGpsLocked || address.lat === null || address.lng === null) return;

    let active = true;
    setShippingCalculating(true);
    api.post("/address/preview-shipping", {
        latitude: address.lat,
        longitude: address.lng,
        state: address.state,
        city: address.city,
        zipCode: address.pincode,
      }).then((res) => {
        if (!active) return;
        if (typeof res.data?.shippingCharge === "number") {
          setShippingCharge(res.data.shippingCharge);
        }
        if (typeof res.data?.calculateShippingForCOD === "boolean") {
          setShippingToggles({
            calculateShippingForCOD: res.data.calculateShippingForCOD !== false,
            calculateShippingForOnline: res.data.calculateShippingForOnline !== false,
          });
        }
      }).catch((err) => {
        if (active) console.error("Error refreshing GPS shipping charge", err);
      }).finally(() => {
        if (active) setShippingCalculating(false);
      });

    return () => {
      active = false;
    };
  }, [isGpsLocked, address.lat, address.lng, address.city, address.state]);


  const handleResetGpsLock = () => {
    setAddress({
      house: "",
      city: "",
      state: "",
      pincode: "",
      lat: null,
      lng: null,
    });
    setShippingCharge(0);
    setShippingCalculating(false);
    setIsGpsLocked(false);
    toast.success("Selected location cleared. You can now edit the address.");
  };

  const handleManualSelect = async (
    lat: number,
    lng: number,
  ) => {
    const toastId = toast.loading("Calculating shipping...");

    try {
      const res = await api.post("/address/save-geo", {
        latitude: lat,
        longitude: lng,
      });

      const { address: addr, shippingCharge } = res.data;

      setAddress({
        house: "",
        city: addr.city || "",
        state: addr.state || "",
        pincode: addr.zipCode || "",
        lat,
        lng,
      });
      setDetectedArea(addr.fullAddress || "");

      setShippingCharge(shippingCharge);
      if (typeof res.data?.calculateShippingForCOD === "boolean") {
        setShippingToggles({
          calculateShippingForCOD: res.data.calculateShippingForCOD !== false,
          calculateShippingForOnline: res.data.calculateShippingForOnline !== false,
        });
      }
      setSuggestions([]);
      setQuery("");
      setIsGpsLocked(true);
      toast.dismiss(toastId);
      toast.success(`Shipping QAR ${shippingCharge}`);
    } catch (err: any) {
      toast.dismiss(toastId);
      const msg = err.response?.data?.message || "Failed to calculate shipping for this location.";
      toast.error(msg);
    }
  };

  // --- COUPON APPLY ---
  const handleApplyCoupon = async (overrideCode?: string) => {
    const code = (typeof overrideCode === "string" ? overrideCode : couponCode).trim();
    if (!code) return;
    setCouponLoading(true);
    try {
      const res = await api.post("/coupon/validate", {
        code,
        orderAmount: Number(checkoutSubtotal),
      });
      setAppliedCoupon(res.data);
      toast.success(
        `Coupon "${res.data.code}" applied! You save QAR ${res.data.discountAmount}`,
      );
      setCouponCode("");
    } catch (err: any) {
      console.error("Coupon validation error:", err);
      const message = err.response?.data?.message || err.message || "Invalid coupon code";
      toast.dismiss();
      toast.error(message, { id: "coupon-apply-error" });
    } finally {
      setCouponLoading(false);
    }
  };

  const handleRemoveCoupon = () => {
    setAppliedCoupon(null);
    setCouponCode("");
  };

  // --- ONLINE PAYMENT LOGIC ---
  const startOnlinePayment = async () => {
    setLoading(true);
    try {
      const response = await api.post("/order/place", {
        couponId: appliedCoupon?.couponId,
        shippingAddress: getFinalShippingAddress(),
        ...(buyNowProductId
          ? {
              buyNowProductId,
              ...(buyNowVariantId ? { buyNowVariantId } : {}),
            }
          : {}),
      });

      const checkoutUrl = new URL(response.data?.checkoutUrl);
      if (checkoutUrl.protocol !== "https:") {
        throw new Error("Invalid Nomod checkout URL");
      }

      isPaymentSuccess.current = true;
      window.location.assign(checkoutUrl.href);
    } catch (error: any) {
      console.error("Nomod checkout initialization failed", error);
      toast.error(error.response?.data?.message || "Unable to start online payment. Please try again.");
      setLoading(false);
    }
  };

  const getFinalShippingAddress = () => {
    const enteredStreet = address.house.trim();
    const area = (address.locality || detectedArea || "").trim();
    let finalFullAddress = enteredStreet;
    if (area && !enteredStreet.toLowerCase().includes(area.toLowerCase())) {
      finalFullAddress = `${enteredStreet}, ${area}`;
    }
    return {
      fullAddress: finalFullAddress,
      city: address.city.trim() || area,
      state: address.state.trim(),
      zipCode: address.pincode.trim(),
      country: "Qatar",
      locality: address.locality || undefined,
      lat: address.lat ?? undefined,
      lng: address.lng ?? undefined,
    };
  };

  // --- PLACE ORDER HANDLER ---
  const handlePlaceOrder = async () => {
    if (checkoutItems.length === 0 || Number(checkoutSubtotal) <= 0) {
      toast.error("Your cart is empty. Please add products to continue.", { id: "checkout-empty" });
      navigate("/", { replace: true });
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("open-cart-drawer"));
      }, 150);
      return;
    }

    if (!address.house.trim()) {
      toast.error("Please enter your street address.", { id: "checkout-validate" });
      return;
    }
    if (!address.city.trim()) {
      toast.error("Please enter your city.", { id: "checkout-validate" });
      return;
    }
    if (!address.state.trim()) {
      toast.error("Please select your municipality.", { id: "checkout-validate" });
      return;
    }
    if (!QATAR_MUNICIPALITIES.includes(address.state)) {
      toast.error("Please select a valid Qatar municipality.", { id: "checkout-validate" });
      return;
    }

    const shippingAddressPayload = getFinalShippingAddress();

    // Persist full shipping address with GPS coordinates to user's address record
    try {
      await api.post("/address/save-manual", {
        fullAddress: shippingAddressPayload.fullAddress,
        city: shippingAddressPayload.city,
        state: shippingAddressPayload.state,
        zipCode: shippingAddressPayload.zipCode,
        locality: address.locality || undefined,
        latitude: shippingAddressPayload.lat,
        longitude: shippingAddressPayload.lng,
      });
    } catch (saveErr) {
      console.error("Failed to save address before order:", saveErr);
    }

    if (paymentMethod === "POD") {
      let toastId;
      try {
        setLoading(true);
        toastId = toast.loading("Processing your order...");

        const placedOrder = await api.post("/order/placeOrderPOD", {
          couponId: appliedCoupon?.couponId,
          shippingAddress: shippingAddressPayload,
          ...(buyNowProductId
            ? {
                buyNowProductId,
                ...(buyNowVariantId ? { buyNowVariantId } : {}),
              }
            : {}),
        });

        isPaymentSuccess.current = true;
        if (buyNowProductId) {
          if (fetchCart) await fetchCart();
        } else {
          if (clearCart) clearCart();
        }
        toast.dismiss(toastId);
        toast.success("Order placed successfully!");

        trackMetaPurchase({
          orderId: placedOrder.data.order.id,
          numItems: checkoutItems.reduce((sum, i) => sum + i.quantity, 0),
          amount: Number(totalAmount),
          currency: "QAR",
        });

        setShowSuccessModal(true);
      } catch (e) {
        if (toastId) toast.dismiss(toastId);
        toast.error("Order failed. Please try again.");
      } finally {
        setLoading(false);
      }
    } else if (paymentMethod === "QR") {
      setQrModalStep("SCAN");
      const isMobile =
        typeof window !== "undefined" &&
        (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 640);
      setQrViewMode(isMobile ? "APP" : "QR");
      setShowQrModal(true);
    } else {
      await startOnlinePayment();
    }
  };

  const handleConfirmQrPayment = async () => {
    const cleanTxId = qrTransactionId.trim().replace(/[\s-]/g, "");
    const txValidation = validateTransactionId(qrTransactionId);

    // If customer entered a Transaction ID, validate format
    if (qrTransactionId.trim() && !txValidation.isValid) {
      toast.error(txValidation.message);
      return;
    }

    setQrSubmitting(true);
    const toastId = toast.loading("Submitting your order...");

    try {
      const shippingAddressPayload = getFinalShippingAddress();
      const fd = new FormData();
      if (appliedCoupon?.couponId) fd.append("couponId", appliedCoupon.couponId);
      if (buyNowProductId) fd.append("buyNowProductId", buyNowProductId);
      if (buyNowVariantId) fd.append("buyNowVariantId", buyNowVariantId);
      if (cleanTxId) fd.append("transactionId", cleanTxId);
      if (qrScreenshotFile) fd.append("screenshot", qrScreenshotFile);
      fd.append("shippingAddress", JSON.stringify(shippingAddressPayload));

      const placedOrder = await api.post("/order/placeOrderQR", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      isPaymentSuccess.current = true;
      if (buyNowProductId) {
        if (fetchCart) await fetchCart();
      } else {
        if (clearCart) clearCart();
      }

      toast.dismiss(toastId);
      toast.success("Order placed successfully with QR payment!");
      setShowQrModal(false);
      setQrModalStep("SCAN");
      setQrTransactionId("");
      setQrScreenshotFile(null);
      setQrScreenshotPreview(null);

      trackMetaPurchase({
        orderId: placedOrder.data.order.id,
        numItems: checkoutItems.reduce((sum, i) => sum + i.quantity, 0),
        amount: Number(totalAmount),
        currency: "QAR",
      });

      setShowSuccessModal(true);
    } catch (err: any) {
      toast.dismiss(toastId);
      toast.error(err.response?.data?.message || "Failed to place order. Please try again.");
    } finally {
      setQrSubmitting(false);
    }
  };

  const discountAmount = appliedCoupon?.discountAmount ?? 0;
  const isShippingDisabledForPayment =
    (paymentMethod === "POD" && !shippingToggles.calculateShippingForCOD) ||
    (paymentMethod === "Online" && !shippingToggles.calculateShippingForOnline) ||
    false;
  const effectiveShippingCharge = checkoutItems.length === 0
    ? 0
    : isShippingDisabledForPayment
    ? 0
    : Number(shippingCharge || 0);
  const totalAmount = checkoutItems.length === 0
    ? "0.00"
    : Math.max(
        checkoutSubtotal + effectiveShippingCharge - discountAmount,
        0,
      ).toFixed(2);

  // Generate dynamic amount-embedded UPI QR code on the fly
  useEffect(() => {
    if (qrConfig.upiId && totalAmount) {
      const payeeName = qrConfig.accountName?.trim() || "Store";
      const upiUri = `upi://pay?pa=${encodeURIComponent(qrConfig.upiId.trim())}&pn=${encodeURIComponent(
        payeeName
      )}&am=${totalAmount}&cu=QAR&tn=${encodeURIComponent(`Order Payment - ${payeeName}`)}`;

      QRCode.toDataURL(upiUri, {
        width: 340,
        margin: 1.5,
        color: {
          dark: "#000000",
          light: "#ffffff",
        },
        errorCorrectionLevel: "M",
      })
        .then((url: string) => setDynamicQrUrl(url))
        .catch((err: unknown) => {
          console.error("Failed to generate dynamic UPI QR", err);
          setDynamicQrUrl(null);
        });
    } else {
      setDynamicQrUrl(null);
    }
  }, [qrConfig.upiId, qrConfig.accountName, totalAmount]);

  // Handle direct 1-tap redirect to mobile UPI apps (GPay, PhonePe, Paytm, or Any UPI app)
  const handleUpiAppRedirect = (app: "gpay" | "phonepe" | "paytm" | "any") => {
    if (!qrConfig.upiId) {
      toast.error("UPI details are not configured for this store");
      return;
    }

    const payeeName = qrConfig.accountName?.trim() || "Store";
    const pa = qrConfig.upiId.trim();
    const pn = payeeName;
    const am = String(totalAmount);
    const tn = `Order Payment - ${payeeName}`;
    const cu = "QAR";

    const upiQuery = `pa=${encodeURIComponent(pa)}&pn=${encodeURIComponent(pn)}&am=${encodeURIComponent(
      am
    )}&cu=${cu}&tn=${encodeURIComponent(tn)}`;
    const genericUpiUri = `upi://pay?${upiQuery}`;

    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
    const isAndroid = /Android/i.test(userAgent);
    const isIOS = /iPhone|iPad|iPod/i.test(userAgent);

    let targetUrl = genericUpiUri;

    if (app === "gpay") {
      if (isAndroid) {
        targetUrl = `intent://pay?${upiQuery}#Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;S.browser_fallback_url=${encodeURIComponent(
          "https://play.google.com/store/apps/details?id=com.google.android.apps.nbu.paisa.user"
        )};end;`;
      } else if (isIOS) {
        targetUrl = `gpay://upi/pay?${upiQuery}`;
      } else {
        targetUrl = genericUpiUri;
      }
    } else if (app === "phonepe") {
      if (isAndroid) {
        targetUrl = `intent://pay?${upiQuery}#Intent;scheme=upi;package=com.phonepe.app;S.browser_fallback_url=${encodeURIComponent(
          "https://play.google.com/store/apps/details?id=com.phonepe.app"
        )};end;`;
      } else if (isIOS) {
        targetUrl = `phonepe://pay?${upiQuery}`;
      } else {
        targetUrl = genericUpiUri;
      }
    } else if (app === "paytm") {
      if (isAndroid) {
        targetUrl = `intent://pay?${upiQuery}#Intent;scheme=upi;package=net.one97.paytm;S.browser_fallback_url=${encodeURIComponent(
          "https://play.google.com/store/apps/details?id=net.one97.paytm"
        )};end;`;
      } else if (isIOS) {
        targetUrl = `paytmmp://pay?${upiQuery}`;
      } else {
        targetUrl = genericUpiUri;
      }
    }

    const appTitle =
      app === "gpay"
        ? "Google Pay"
        : app === "phonepe"
        ? "PhonePe"
        : app === "paytm"
        ? "Paytm"
        : "UPI App";

    // Auto-copy UPI ID to clipboard so the customer has it handy
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(qrConfig.upiId);
      }
    } catch (_) {}

    toast.success(`Opening ${appTitle}... Complete payment and enter the 12-digit UTR!`, {
      icon: "📱",
      duration: 4000,
    });

    // Advance to Step 2 so upon return the user lands directly on UTR verification
    setTimeout(() => {
      setQrModalStep("SUBMIT");
    }, 1200);

    // Launch app deep link
    window.location.href = targetUrl;
  };


  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-900 pt-24 pb-24 md:pb-12 relative overflow-x-hidden">
      <style>{`
        .leaflet-container {
          cursor: pointer !important;
        }
      `}</style>
      {/* MAIN WRAPPER DIV */}
      <div className="mx-auto max-w-screen-2xl px-4 sm:px-6 md:px-12 transition-opacity duration-300 opacity-100">
        {/* --- Header & Back Button --- */}
        <div className="mb-8 mt-10">
          <button
            type="button"
            onClick={() => {
              setFeedbackTriggerSource(paymentMethod === "POD" ? "COD_CHECKOUT_EXIT" : "CHECKOUT_EXIT");
              setFeedbackModalOpen(true);
            }}
            className="group inline-flex items-center gap-2 text-xs font-bold tracking-widest text-slate-400 hover:text-slate-800 transition-colors duration-200 uppercase cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5 stroke-[2.5]" />
            Go Back
          </button>
        </div>

        <div className="md:grid md:grid-cols-12 md:gap-x-8 lg:gap-x-16 xl:gap-x-28 items-start">
          
          {/* ================= LEFT SIDE: FORM ================= */}
          <div className="md:col-span-7 bg-white rounded-3xl md:rounded-[2rem] shadow-sm border border-gray-100 p-4 sm:p-6 md:p-10 mb-8 md:mb-0">
            <div className="mb-8">
              <h1 className="text-3xl font-bold tracking-tighter text-gray-900 sm:text-4xl mb-2">
                Checkout
              </h1>
              <p className="text-gray-500">Complete your purchase securely.</p>
            </div>

            <form onSubmit={(e) => e.preventDefault()}>
              {/* Shipping Address */}
              <div className="border-b border-gray-100 pb-10">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                  <h2 className="text-base font-bold uppercase tracking-wider text-slate-800 flex items-center gap-2">
                    <MapPinIcon className="h-4 w-4 text-slate-600" /> Shipping Address
                  </h2>
                  {isGpsLocked ? (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-50/50 text-emerald-700 border border-emerald-100/70">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        Location Selected
                      </span>
                      <button
                        type="button"
                        onClick={handleResetGpsLock}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-slate-200 text-slate-500 hover:text-rose-600 hover:border-rose-200 hover:bg-rose-50/30 text-xs font-semibold transition"
                      >
                        Reset
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className="grid grid-cols-1 gap-y-5 sm:grid-cols-2 sm:gap-x-4">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5 flex items-center justify-between w-full sm:w-1/2">
                      <span>P.O. Box <span className="font-normal normal-case">(optional)</span></span>
                    </label>
                    <div className="relative w-full sm:w-1/2">
                      <input
                        type="text"
                        value={address.pincode}
                        onChange={(e) => {
                          if (!isGpsLocked) {
                            setAddress((prev) => ({ ...prev, pincode: e.target.value.slice(0, 20) }));
                          }
                        }}
                        readOnly={isGpsLocked}
                        placeholder="Enter P.O. Box (optional)"
                        maxLength={20}
                        className={`block w-full rounded-xl border px-4 py-2.5 shadow-sm sm:text-sm transition focus:outline-none pr-10 ${
                          isGpsLocked
                            ? "bg-slate-50 border-slate-200 text-slate-400 cursor-not-allowed select-none"
                            : "bg-white border-slate-200 focus:border-black focus:ring-1 focus:ring-black"
                        }`}
                      />
                      {isGpsLocked && (
                        <LockClosedIcon className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-300" />
                      )}
                    </div>
                  </div>

                  <div className="sm:col-span-2 relative">
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                      Street Address
                    </label>

                    <input
                      type="text"
                      value={address.house}
                      onChange={(e) => {
                        if (isGpsLocked) {
                          setAddress((prev) => ({ ...prev, house: e.target.value }));
                        } else {
                          setAddress({
                            ...address,
                            house: e.target.value,
                            lat: null,
                            lng: null,
                          });
                          setQuery(e.target.value);
                        }
                      }}
                      className="block w-full rounded-xl border border-slate-200 px-4 py-2.5 shadow-sm focus:outline-none focus:border-black focus:ring-1 focus:ring-black sm:text-sm transition bg-white"
                      placeholder="e.g. Flat 402, Skyline Apartments"
                    />

                    {suggestions.length > 0 && !isGpsLocked && (
                      <ul className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-xl max-h-60 overflow-auto">
                        {suggestions.map((s, i) => (
                          <li
                            key={i}
                            className="px-4 py-3 text-sm hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-b-0 transition-colors"
                            onClick={() =>
                                handleManualSelect(parseFloat(s.lat), parseFloat(s.lon))
                            }
                          >
                            {s.display_name}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                      City
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={address.city}
                        onChange={(e) => setAddress((prev) => ({ ...prev, city: e.target.value }))}
                        readOnly={isGpsLocked}
                        placeholder="Enter city"
                        className="block w-full rounded-xl border border-slate-200 px-4 py-2.5 shadow-sm bg-white sm:text-sm transition pr-10"
                      />
                      {isGpsLocked && <LockClosedIcon className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-300" />}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                      Municipality
                    </label>
                    <select
                      value={address.state}
                      onChange={(e) => setAddress((prev) => ({ ...prev, state: e.target.value }))}
                      disabled={isGpsLocked}
                      className="block w-full rounded-xl border border-slate-200 px-4 py-2.5 shadow-sm bg-white sm:text-sm transition disabled:bg-slate-50 disabled:text-slate-400"
                    >
                      <option value="">Select municipality</option>
                      {QATAR_MUNICIPALITIES.map((mun) => <option key={mun} value={mun}>{mun}</option>)}
                    </select>
                  </div>
                </div>

              </div>

              {/* Payment Method Option Frame */}
              <div className="pt-10">
                <h2 className="text-lg font-bold uppercase tracking-wider text-gray-900 mb-6 flex items-center gap-2">
                  <CreditCardIcon className="h-5 w-5" /> Payment Method
                </h2>

                <div
                  className={`grid grid-cols-1 gap-4 ${
                    SHOW_ONLINE_PAYMENT
                      ? qrConfig.enabled && (qrConfig.upiId || qrConfig.qrCode)
                        ? "sm:grid-cols-3"
                        : "sm:grid-cols-2"
                      : qrConfig.enabled && (qrConfig.upiId || qrConfig.qrCode)
                        ? "sm:grid-cols-2"
                        : "sm:grid-cols-1 max-w-md"
                  }`}
                >
                  {SHOW_ONLINE_PAYMENT && (
                    <div
                      onClick={() => setPaymentMethod("Online")}
                      className={`relative cursor-pointer rounded-2xl border p-5 shadow-sm transition-all duration-200 ${
                        paymentMethod === "Online"
                          ? "border-[var(--theme-primary)] bg-[var(--theme-primary)] text-[var(--theme-primary-ink)] ring-2 ring-[var(--theme-primary)] ring-offset-2"
                          : "border-gray-200 bg-white hover:border-gray-300 hover:shadow-md"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-bold text-sm uppercase tracking-wide">
                          Pay Online
                        </span>
                        <CreditCardIcon
                          className={`h-6 w-6 ${
                            paymentMethod === "Online" ? "text-gray-300" : "text-gray-400"
                          }`}
                        />
                      </div>
                      <p className={`text-xs ${paymentMethod === "Online" ? "text-gray-400" : "text-gray-500"}`}>
                        Secure payment by card, Apple Pay, Google Pay, Tabby and more
                      </p>
                      {!shippingToggles.calculateShippingForOnline && (
                        <div className="mt-2.5">
                          <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            paymentMethod === "Online" ? "bg-white/20 text-white" : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                          }`}>
                            Free Shipping
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {false && qrConfig.enabled && (qrConfig.upiId || qrConfig.qrCode) && (
                    <div
                      onClick={() => setPaymentMethod("QR")}
                      className={`relative cursor-pointer rounded-2xl border p-5 shadow-sm transition-all duration-200 ${
                        paymentMethod === "QR"
                          ? "border-[var(--theme-primary)] bg-[var(--theme-primary)] text-[var(--theme-primary-ink)] ring-2 ring-[var(--theme-primary)] ring-offset-2"
                          : "border-gray-200 bg-white hover:border-gray-300 hover:shadow-md"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-bold text-sm uppercase tracking-wide flex items-center gap-1.5">
                          Pay with QR
                        </span>
                        <QrCode
                          className={`h-6 w-6 ${
                            paymentMethod === "QR" ? "text-gray-300" : "text-gray-400"
                          }`}
                        />
                      </div>
                      <p className={`text-xs ${paymentMethod === "QR" ? "text-gray-400" : "text-gray-500"}`}>
                        Scan QR &amp; Pay via UPI
                      </p>
                      {!shippingToggles.calculateShippingForQR && (
                        <div className="mt-2.5">
                          <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            paymentMethod === "QR" ? "bg-white/20 text-white" : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                          }`}>
                            Free Shipping
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  <div
                    onClick={() => setPaymentMethod("POD")}
                    className={`relative cursor-pointer rounded-2xl border p-5 shadow-sm transition-all duration-200 ${
                      paymentMethod === "POD"
                        ? "border-[var(--theme-primary)] bg-[var(--theme-primary)] text-[var(--theme-primary-ink)] ring-2 ring-[var(--theme-primary)] ring-offset-2"
                        : "border-gray-200 bg-white hover:border-gray-300 hover:shadow-md"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold text-sm uppercase tracking-wide">
                        Cash on Delivery
                      </span>
                      <BanknotesIcon
                        className={`h-6 w-6 ${
                          paymentMethod === "POD" ? "text-gray-300" : "text-gray-400"
                        }`}
                      />
                    </div>
                    <p className={`text-xs ${paymentMethod === "POD" ? "text-gray-400" : "text-gray-500"}`}>
                      Pay cash upon delivery
                    </p>
                    {!shippingToggles.calculateShippingForCOD && (
                      <div className="mt-2.5">
                        <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          paymentMethod === "POD" ? "bg-white/20 text-white" : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                        }`}>
                          Free Shipping
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Submit Button (Desktop/Tablet layout contexts only) */}
              <div className="mt-10 hidden pt-6 md:block">
                <button
                  type="button"
                  onClick={handlePlaceOrder}
                  disabled={loading || shippingCalculating || checkoutItems.length === 0}
                  className="w-full rounded-full bg-[var(--theme-primary)] px-6 py-4 text-sm font-bold uppercase tracking-widest text-[var(--theme-primary-ink)] shadow-lg hover:bg-[var(--theme-primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:-translate-y-1 hover:shadow-xl cursor-pointer"
                >
                  {loading
                    ? "Processing..."
                    : checkoutItems.length === 0
                      ? "Cart is Empty"
                      : paymentMethod === "POD"
                        ? `Place Order — QAR ${totalAmount}`
                        : paymentMethod === "QR"
                          ? `Pay with QR — QAR ${totalAmount}`
                          : `Pay Now — QAR ${totalAmount}`}
                </button>
              </div>
            </form>
          </div>

          {/* ================= RIGHT SIDE: SUMMARY (Desktop View Only) ================= */}
          <div className="hidden md:block md:col-span-5">
            <div className="bg-white rounded-[2rem] shadow-sm border border-gray-100 p-6 md:sticky md:top-24">
              <h2 className="text-lg font-bold uppercase tracking-wider text-gray-900 mb-6 flex items-center gap-2">
                <Package className="h-5 w-5" /> Order Summary
              </h2>

              {checkoutItems.length === 0 ? (
                <div className="py-8 text-center text-gray-400 text-xs bg-gray-50/50 rounded-2xl border border-dashed border-gray-200 mb-6">
                  <p className="font-semibold text-gray-600">Your cart is empty</p>
                  <button
                    type="button"
                    onClick={() => navigate("/products")}
                    className="mt-2 text-xs font-bold uppercase tracking-wider text-[var(--theme-primary)] hover:underline cursor-pointer"
                  >
                    Start Shopping →
                  </button>
                </div>
              ) : (
                <ul className="divide-y divide-gray-100 mb-6 max-h-[400px] overflow-y-auto custom-scrollbar">
                  {checkoutItems.map((item) => (
                    <li key={item._id} className="flex py-4">
                      <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-xl border border-gray-100 bg-gray-50">
                        <img
                          src={item.image}
                          alt={item.name}
                          className="h-full w-full object-cover object-center"
                        />
                      </div>
                      <div className="ml-4 flex flex-1 flex-col justify-center">
                        <div className="flex justify-between text-sm font-medium text-gray-900">
                          <h3 className="line-clamp-1">{item.name}</h3>
                          <p className="ml-4 font-bold">
                            QAR {item.price * item.quantity}
                          </p>
                        </div>
                        {item.selectedOptions && Object.keys(item.selectedOptions).length > 0 && (
                          <p
                            className="mt-0.5 text-xs text-gray-500 font-medium line-clamp-2 break-words leading-relaxed cursor-help"
                            title={Object.entries(item.selectedOptions)
                              .map(([axis, value]) => `${axis}: ${value}`)
                              .join(" · ")}
                          >
                            {Object.entries(item.selectedOptions)
                              .map(([axis, value]) => `${axis}: ${value}`)
                              .join(" · ")}
                          </p>
                        )}
                        <p className="mt-1 text-xs text-gray-500">
                          Qty {item.quantity}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="space-y-3 pt-6 border-t border-gray-100 text-sm">
                <div className="flex justify-between text-gray-500">
                  <span>Subtotal</span>
                  <span>QAR {checkoutSubtotal}</span>
                </div>
                <div className="flex justify-between text-gray-500">
                  <span className="flex items-center gap-1">
                    Shipping <TruckIcon className="h-3 w-3" />
                  </span>
                  <span className="font-medium text-gray-900">
                    {shippingCalculating ? (
                      <span className="inline-flex items-center gap-1.5 text-indigo-600" role="status" aria-live="polite">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Calculating…
                      </span>
                    ) : !isGpsLocked && !address.state.trim() && !address.pincode.trim() ? (
                      <span className="text-gray-400 italic">Enter address to calculate</span>
                    ) : effectiveShippingCharge === 0 ? (
                      <span className="text-green-600 font-medium flex items-center gap-1.5">
                        <span>Free</span>
                        {isShippingDisabledForPayment && (
                          <span className="text-[10px] bg-green-100 text-green-800 font-semibold px-1.5 py-0.5 rounded-full">
                            Free for {paymentMethod === "POD" ? "COD" : paymentMethod === "QR" ? "QR" : "Online"}
                          </span>
                        )}
                      </span>
                    ) : (
                      `QAR ${effectiveShippingCharge}`
                    )}
                  </span>
                </div>

                {/* Coupon Module Wrapper */}
                <div className="pt-2">
                  {!appliedCoupon ? (
                    <>
                      <div className="flex gap-2">
                      <div className="relative flex-1">
                        <TagIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <input
                          type="text"
                          value={couponCode}
                          onChange={(e) =>
                            setCouponCode(e.target.value.toUpperCase())
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleApplyCoupon();
                            }
                          }}
                          placeholder="Coupon code"
                          className="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-200 text-sm bg-gray-50 focus:outline-none focus:border-black transition"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => handleApplyCoupon()}
                        disabled={couponLoading || !couponCode.trim()}
                        className="px-4 py-2 rounded-xl bg-[var(--theme-primary)] text-[var(--theme-primary-ink)] text-xs font-bold uppercase tracking-wider disabled:opacity-50 hover:bg-[var(--theme-primary-hover)] transition"
                      >
                        {couponLoading ? "..." : "Apply"}
                      </button>
                    </div>
                    <CouponCarousel
                      variant="compact"
                      onApplyCoupon={(code) => handleApplyCoupon(code)}
                      className="mt-2.5"
                    />
                  </>
                  ) : (
                    <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-xl px-3 py-2">
                      <div className="flex items-center gap-2">
                        <TagIcon className="h-4 w-4 text-green-600" />
                        <div>
                          <p className="text-xs font-bold text-green-700">
                            {appliedCoupon.code}
                          </p>
                          <p className="text-xs text-green-600">
                            {appliedCoupon.discountType === "PERCENTAGE"
                              ? `${appliedCoupon.discountValue}% off`
                              : `QAR ${appliedCoupon.discountValue} off`}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={handleRemoveCoupon}
                        className="text-gray-400 hover:text-red-500 transition"
                      >
                        <XCircleIcon className="h-5 w-5" />
                      </button>
                    </div>
                  )}
                </div>

                {discountAmount > 0 && (
                  <div className="flex justify-between text-green-600">
                    <span>Discount</span>
                    <span className="font-medium">−QAR {discountAmount}</span>
                  </div>
                )}

                <div className="flex justify-between border-t border-gray-100 pt-4">
                  <span className="text-base font-bold text-gray-900">
                    Total
                  </span>
                  <span className="text-xl font-bold text-[var(--theme-primary)]">
                    QAR {totalAmount}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ================= INLINE BOTTOM CONTAINER (For Mobile Viewports Only) ================= */}
        {/* Removed 'fixed bottom-0' so it stacks cleanly under the form fields and map naturally */}
        <div
          className="mt-8 bg-white rounded-3xl border border-gray-100 p-6 shadow-sm md:hidden transition-all duration-300"
        >
          {/* Coupon Input — Mobile (Always Visible) */}
          <div className="mb-4 pt-1">
            {!appliedCoupon ? (
              <>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <TagIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                      type="text"
                      value={couponCode}
                      onChange={(e) =>
                        setCouponCode(e.target.value.toUpperCase())
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleApplyCoupon();
                        }
                      }}
                      placeholder="Coupon code"
                      className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-gray-200 text-sm bg-gray-50 focus:outline-none focus:border-black transition"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => handleApplyCoupon()}
                    disabled={couponLoading || !couponCode.trim()}
                    className="px-4 py-2.5 rounded-xl bg-[var(--theme-primary)] text-[var(--theme-primary-ink)] text-xs font-bold uppercase tracking-wider disabled:opacity-50 hover:bg-[var(--theme-primary-hover)] transition"
                  >
                    {couponLoading ? "..." : "Apply"}
                  </button>
                </div>
                <CouponCarousel
                  variant="compact"
                  onApplyCoupon={(code) => handleApplyCoupon(code)}
                  className="mt-2.5"
                />
              </>
            ) : (
              <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-xl px-3 py-2">
                <div className="flex items-center gap-2">
                  <TagIcon className="h-4 w-4 text-green-600" />
                  <div>
                    <p className="text-xs font-bold text-green-700">
                      {appliedCoupon.code}
                    </p>
                    <p className="text-xs text-green-600">
                      {appliedCoupon.discountType === "PERCENTAGE"
                        ? `${appliedCoupon.discountValue}% off`
                        : `QAR ${appliedCoupon.discountValue} off`}
                    </p>
                  </div>
                </div>
                <button onClick={handleRemoveCoupon} className="text-gray-400 hover:text-red-500 transition">
                  <XCircleIcon className="h-5 w-5" />
                </button>
              </div>
            )}
          </div>

          {discountAmount > 0 && (
            <div className="mb-2 flex justify-between text-sm text-green-600">
              <span>Discount</span>
              <span className="font-medium">−QAR {discountAmount}</span>
            </div>
          )}

          <div className="mb-4 flex items-center justify-between text-base font-bold text-gray-900">
            <span>Total</span>
            <span className="text-xl text-[var(--theme-primary)]">QAR {totalAmount}</span>
          </div>
          <button
            type="button"
            onClick={handlePlaceOrder}
            disabled={loading || shippingCalculating || checkoutItems.length === 0}
            className="w-full rounded-full bg-[var(--theme-primary)] px-4 py-4 text-sm font-bold uppercase tracking-widest text-[var(--theme-primary-ink)] shadow-md hover:bg-[var(--theme-primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {loading
              ? "Processing..."
              : checkoutItems.length === 0
                ? "Cart is Empty"
                : paymentMethod === "POD"
                  ? "Place Order"
                  : paymentMethod === "QR"
                    ? "Pay with QR"
                    : "Pay Now"}
          </button>

          <Popover className="mt-4 flex justify-center relative">
            {({ open }) => (
              <Fragment>
                <Popover.Button className="flex items-center gap-1 text-xs font-medium text-gray-500 uppercase tracking-wide outline-none">
                  {open ? "Hide Details" : "View Details"}
                  <ChevronUpIcon
                    className={`h-3 w-3 transition-transform ${
                      open ? "rotate-180" : ""
                    }`}
                  />
                </Popover.Button>
                <Transition
                  as={Fragment}
                  enter="transition ease-out duration-200"
                  enterFrom="opacity-0 translate-y-10"
                  enterTo="opacity-100 translate-y-0"
                  leave="transition ease-in duration-150"
                  leaveFrom="opacity-100 translate-y-0"
                  leaveTo="opacity-0 translate-y-10"
                >
                  <Popover.Panel className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-[calc(100vw-2rem)] sm:w-full max-w-md bg-white border border-gray-200 px-6 py-6 shadow-2xl max-h-[60vh] overflow-y-auto rounded-3xl z-50">
                    <h3 className="text-sm font-bold uppercase text-gray-900 mb-4">
                      Order Summary
                    </h3>
                    <ul className="divide-y divide-gray-100 mb-4">
                      {checkoutItems.map((item) => (
                        <li key={item._id} className="flex py-3">
                          <img
                            src={item.image}
                            alt={item.name}
                            className="h-12 w-12 rounded-lg object-cover bg-gray-50 flex-shrink-0"
                          />
                          <div className="ml-3 flex-1 min-w-0">
                            <p className="text-sm font-bold text-gray-900 truncate">
                              {item.name}
                            </p>
                            {item.selectedOptions && Object.keys(item.selectedOptions).length > 0 && (
                              <p
                                className="text-xs text-gray-500 font-medium line-clamp-2 break-words leading-relaxed cursor-help"
                                title={Object.entries(item.selectedOptions)
                                  .map(([axis, value]) => `${axis}: ${value}`)
                                  .join(" · ")}
                              >
                                {Object.entries(item.selectedOptions)
                                  .map(([axis, value]) => `${axis}: ${value}`)
                                  .join(" · ")}
                              </p>
                            )}
                            <p className="text-xs text-gray-500">
                              Qty: {item.quantity}
                            </p>
                          </div>
                          <p className="text-sm font-bold text-gray-900 ml-2">
                            QAR {item.price * item.quantity}
                          </p>
                        </li>
                      ))}
                    </ul>

                    <div className="border-t border-gray-100 pt-4 space-y-2 text-sm">
                      <div className="flex justify-between text-gray-500">
                        <span>Subtotal</span>
                        <span>QAR {checkoutSubtotal}</span>
                      </div>
                      <div className="flex justify-between text-gray-500">
                        <span className="flex items-center gap-1">
                          Shipping <TruckIcon className="h-3 w-3" />
                        </span>
                        <span>
                          {shippingCalculating ? (
                            <span className="inline-flex items-center gap-1.5 text-indigo-600" role="status" aria-live="polite">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Calculating…
                            </span>
                          ) : !isGpsLocked && !address.state.trim() && !address.pincode.trim() ? (
                            <span className="text-gray-400 italic">Enter address to calculate</span>
                          ) : effectiveShippingCharge === 0 ? (
                            <span className="text-green-600 font-medium flex items-center gap-1.5">
                              <span>Free</span>
                              {isShippingDisabledForPayment && (
                                <span className="text-[10px] bg-green-100 text-green-800 font-semibold px-1.5 py-0.5 rounded-full">
                                  Free for {paymentMethod === "POD" ? "COD" : paymentMethod === "QR" ? "QR" : "Online"}
                                </span>
                              )}
                            </span>
                          ) : (
                            `QAR ${effectiveShippingCharge}`
                          )}
                        </span>
                      </div>

                      {discountAmount > 0 && (
                        <div className="flex justify-between text-green-600">
                          <span>Discount</span>
                          <span className="font-medium">−QAR {discountAmount}</span>
                        </div>
                      )}
                      <div className="flex justify-between border-t border-gray-100 pt-3">
                        <span className="font-bold text-gray-900">Total</span>
                        <span className="text-base font-bold text-[var(--theme-primary)]">
                          QAR {totalAmount}
                        </span>
                      </div>
                    </div>
                  </Popover.Panel>
                </Transition>
              </Fragment>
            )}
          </Popover>
        </div>

      </div>

      {/* ================= PAY WITH QR MODAL ================= */}
      {createPortal(
        <AnimatePresence>
          {showQrModal && (
            <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => {
                  if (!qrSubmitting) {
                    setShowQrModal(false);
                    setQrModalStep("SCAN");
                  }
                }}
                className="absolute inset-0 bg-black/60 backdrop-blur-md"
              />

              <motion.div
                initial={{ scale: 0.92, opacity: 0, y: 15 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.92, opacity: 0, y: 15 }}
                className="relative w-full max-w-md rounded-3xl bg-white p-6 sm:p-7 shadow-2xl z-10 max-h-[92vh] overflow-y-auto"
              >
                {/* Header */}
                <div className="flex items-center justify-between pb-3.5 border-b border-gray-100">
                  <div className="flex items-center gap-2.5">
                    {qrModalStep === "SUBMIT" ? (
                      <button
                        type="button"
                        onClick={() => setQrModalStep("SCAN")}
                        className="p-1.5 -ml-1 rounded-xl hover:bg-gray-100 text-gray-600 transition-colors"
                        title="Back to QR scanner"
                      >
                        <ArrowLeft className="w-5 h-5" />
                      </button>
                    ) : (
                      <div className="p-2 bg-purple-100 text-purple-700 rounded-xl">
                        <QrCode className="w-5 h-5" />
                      </div>
                    )}
                    <div>
                      <h3 className="text-base font-black text-gray-900 tracking-tight">
                        {qrModalStep === "SUBMIT"
                          ? "Verify Payment"
                          : qrViewMode === "APP"
                          ? "Pay via UPI App"
                          : "Scan QR to Pay"}
                      </h3>
                      <p className="text-[11px] text-gray-500 font-medium">
                        {qrModalStep === "SUBMIT"
                          ? "Step 2: Enter transaction proof"
                          : qrViewMode === "APP"
                          ? "Step 1: Choose GPay, PhonePe, or Paytm"
                          : "Step 1: Scan with any UPI app"}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={qrSubmitting}
                    onClick={() => {
                      setShowQrModal(false);
                      setQrModalStep("SCAN");
                    }}
                    className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Amount Pill */}
                <div className="mt-4 p-3.5 rounded-2xl bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-100/80 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-purple-600">Total Payable Amount</p>
                    <p className="text-2xl font-black text-gray-900 mt-0.5">QAR {totalAmount}</p>
                  </div>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white text-purple-700 text-xs font-bold border border-purple-200/60 shadow-xs">
                    UPI Accepted
                  </span>
                </div>

                {/* Mobile / QR View Mode Switcher */}
                {qrModalStep === "SCAN" && (
                  <div className="grid grid-cols-2 p-1 bg-slate-100 rounded-2xl mt-3.5 mb-1 border border-slate-200/70">
                    <button
                      type="button"
                      onClick={() => setQrViewMode("APP")}
                      className={`py-2 px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                        qrViewMode === "APP"
                          ? "bg-white text-purple-700 shadow-sm"
                          : "text-slate-500 hover:text-slate-900"
                      }`}
                    >
                      <Smartphone className="w-4 h-4 text-purple-600" />
                      <span>Pay via UPI App</span>
                      <span className="text-[9px] font-bold text-emerald-700 bg-emerald-100/90 px-1.5 py-0.5 rounded-full border border-emerald-200/60 leading-none">
                        Fast
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setQrViewMode("QR")}
                      className={`py-2 px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                        qrViewMode === "QR"
                          ? "bg-white text-purple-700 shadow-sm"
                          : "text-slate-500 hover:text-slate-900"
                      }`}
                    >
                      <QrCode className="w-4 h-4 text-purple-600" />
                      <span>Scan QR Code</span>
                    </button>
                  </div>
                )}

                {/* STEP 1: SCAN OR DIRECT APP REDIRECT */}
                {qrModalStep === "SCAN" && (
                  <>
                    {/* OPTION A: MOBILE 1-TAP REDIRECT TO GPAY, PHONEPE, PAYTM */}
                    {qrViewMode === "APP" && (
                      <div className="mt-3 w-full flex flex-col items-center">
                        <div className="w-full text-center mb-3">
                          <p className="text-xs font-bold text-slate-800">Tap your installed UPI app to pay</p>
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            Amount QAR {totalAmount} and payee are automatically pre-filled.
                          </p>
                        </div>

                        {/* 3 Main Redirect App Cards: GPay, PhonePe, Paytm */}
                        <div className="grid grid-cols-3 gap-2.5 w-full">
                          {/* Google Pay */}
                          <button
                            type="button"
                            onClick={() => handleUpiAppRedirect("gpay")}
                            className="group relative flex flex-col items-center justify-center p-3 rounded-2xl border-2 border-slate-200 bg-white hover:border-blue-500 hover:bg-blue-50/20 active:scale-95 transition-all shadow-xs cursor-pointer"
                          >
                            <div className="w-11 h-11 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center group-hover:scale-105 transition-transform shadow-xs">
                              <svg viewBox="0 0 24 24" className="w-6 h-6">
                                <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.8-2.4 3.65v3.03h3.88c2.27-2.09 3.665-5.17 3.665-9.12z"/>
                                <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.03c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.13C3.26 21.36 7.33 24 12 24z"/>
                                <path fill="#FBBC05" d="M5.28 14.29c-.25-.72-.38-1.49-.38-2.29s.13-1.57.38-2.29V6.57H1.25C.45 8.15 0 9.99 0 12s.45 3.85 1.25 5.43l4.03-3.14z"/>
                                <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.25 6.57l4.03 3.14c.95-2.83 3.6-4.96 6.72-4.96z"/>
                              </svg>
                            </div>
                            <span className="mt-2 text-xs font-bold text-slate-800 tracking-tight">GPay</span>
                            <span className="text-[10px] text-slate-400 font-medium leading-none mt-0.5">Google Pay</span>
                          </button>

                          {/* PhonePe */}
                          <button
                            type="button"
                            onClick={() => handleUpiAppRedirect("phonepe")}
                            className="group relative flex flex-col items-center justify-center p-3 rounded-2xl border-2 border-slate-200 bg-white hover:border-[#5f259f] hover:bg-purple-50/20 active:scale-95 transition-all shadow-xs cursor-pointer"
                          >
                            <div className="w-11 h-11 rounded-2xl bg-[#5f259f] flex items-center justify-center group-hover:scale-105 transition-transform shadow-xs">
                              <span className="text-white font-black text-xl leading-none">पे</span>
                            </div>
                            <span className="mt-2 text-xs font-bold text-[#5f259f] tracking-tight">PhonePe</span>
                            <span className="text-[10px] text-slate-400 font-medium leading-none mt-0.5">UPI App</span>
                          </button>

                          {/* Paytm */}
                          <button
                            type="button"
                            onClick={() => handleUpiAppRedirect("paytm")}
                            className="group relative flex flex-col items-center justify-center p-3 rounded-2xl border-2 border-slate-200 bg-white hover:border-[#00BAF2] hover:bg-sky-50/20 active:scale-95 transition-all shadow-xs cursor-pointer"
                          >
                            <div className="w-11 h-11 rounded-2xl bg-[#002E6E] flex items-center justify-center group-hover:scale-105 transition-transform shadow-xs px-1">
                              <span className="text-white font-black text-xs">Pay<span className="text-[#00BAF2]">tm</span></span>
                            </div>
                            <span className="mt-2 text-xs font-bold text-[#002E6E] tracking-tight">Paytm</span>
                            <span className="text-[10px] text-slate-400 font-medium leading-none mt-0.5">UPI Wallet</span>
                          </button>
                        </div>

                        {/* Any Other UPI App */}
                        <button
                          type="button"
                          onClick={() => handleUpiAppRedirect("any")}
                          className="mt-2.5 w-full py-2.5 px-3 rounded-2xl border border-slate-200 bg-slate-50/80 hover:bg-slate-100 text-slate-700 text-xs font-bold flex items-center justify-center gap-2 active:scale-98 transition-all cursor-pointer"
                        >
                          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                          <span>Pay with Other UPI App (CRED, BHIM, Amazon Pay)</span>
                          <ExternalLink className="w-3.5 h-3.5 text-slate-400" />
                        </button>

                        {/* Payee Info & Copy UPI ID */}
                        <div className="mt-3.5 w-full p-3 rounded-2xl bg-purple-50/50 border border-purple-100 flex items-center justify-between">
                          <div className="min-w-0 pr-2">
                            <p className="text-[10px] font-bold text-purple-600 uppercase tracking-wider">Payee Account</p>
                            <p className="text-xs font-bold text-slate-800 truncate">{qrConfig.accountName || "Merchant Store"}</p>
                            <p className="text-[11px] font-mono text-slate-600 truncate">{qrConfig.upiId}</p>
                          </div>
                          {qrConfig.upiId && (
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(qrConfig.upiId!);
                                toast.success("UPI ID copied!");
                              }}
                              className="shrink-0 px-2.5 py-1.5 rounded-xl bg-white border border-purple-200 text-purple-700 hover:bg-purple-50 text-[11px] font-bold flex items-center gap-1 transition-colors cursor-pointer"
                            >
                              <Copy className="w-3 h-3" />
                              <span>Copy</span>
                            </button>
                          )}
                        </div>

                        {/* Advance to Step 2 */}
                        <button
                          type="button"
                          onClick={() => setQrModalStep("SUBMIT")}
                          className="mt-4 w-full py-3.5 px-5 rounded-2xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold uppercase tracking-wider shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-98"
                        >
                          <span>I Have Completed Payment</span>
                          <span>→</span>
                        </button>
                      </div>
                    )}

                    {/* OPTION B: SCAN QR CODE WITH PHONE CAMERA / 2ND DEVICE */}
                    {qrViewMode === "QR" && (
                      <div className="mt-3 flex flex-col items-center">
                        {/* Centered QR Frame with decorative scanner corner accents */}
                        <div className="relative p-2.5 bg-white rounded-2xl border border-purple-100 shadow-sm my-1">
                          <span className="absolute top-1 left-1 w-4 h-4 border-t-2 border-l-2 border-purple-600 rounded-tl-md pointer-events-none" />
                          <span className="absolute top-1 right-1 w-4 h-4 border-t-2 border-r-2 border-purple-600 rounded-tr-md pointer-events-none" />
                          <span className="absolute bottom-1 left-1 w-4 h-4 border-b-2 border-l-2 border-purple-600 rounded-bl-md pointer-events-none" />
                          <span className="absolute bottom-1 right-1 w-4 h-4 border-b-2 border-r-2 border-purple-600 rounded-br-md pointer-events-none" />

                          <img
                            src={dynamicQrUrl || qrConfig.qrCode}
                            alt="Payment QR Code"
                            className="w-48 h-48 sm:w-52 sm:h-52 object-contain rounded-xl"
                          />
                        </div>

                        {qrConfig.accountName && (
                          <p className="mt-2 text-xs font-bold text-gray-800">
                            Payee: <span className="text-purple-700">{qrConfig.accountName}</span>
                          </p>
                        )}

                        {qrConfig.upiId && (
                          <div className="mt-2 flex items-center gap-2 bg-gray-50 px-3 py-1.5 rounded-xl border border-gray-200">
                            <span className="text-xs font-mono font-semibold text-gray-700">{qrConfig.upiId}</span>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(qrConfig.upiId!);
                                toast.success("UPI ID copied!");
                              }}
                              className="text-purple-600 hover:text-purple-800 transition-colors p-0.5 cursor-pointer"
                              title="Copy UPI ID"
                            >
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}

                        {/* Quick 1-tap redirect pills inside QR view as well */}
                        <div className="mt-3 w-full pt-2.5 border-t border-slate-100 flex flex-col items-center">
                          <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                            Paying on this phone? 1-Tap Redirect:
                          </p>
                          <div className="flex items-center gap-2 mt-1.5">
                            <button
                              type="button"
                              onClick={() => handleUpiAppRedirect("gpay")}
                              className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-blue-50 hover:text-blue-600 border border-slate-200 text-slate-700 text-[11px] font-bold flex items-center gap-1 transition-colors cursor-pointer"
                            >
                              <span>GPay</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleUpiAppRedirect("phonepe")}
                              className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-purple-50 hover:text-purple-700 border border-slate-200 text-slate-700 text-[11px] font-bold flex items-center gap-1 transition-colors cursor-pointer"
                            >
                              <span>PhonePe</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleUpiAppRedirect("paytm")}
                              className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-sky-50 hover:text-sky-700 border border-slate-200 text-slate-700 text-[11px] font-bold flex items-center gap-1 transition-colors cursor-pointer"
                            >
                              <span>Paytm</span>
                            </button>
                          </div>
                        </div>

                        <p className="mt-2 text-[11px] text-gray-500 text-center max-w-xs">
                          {dynamicQrUrl
                            ? `Scan with GPay, PhonePe, or Paytm — QAR ${totalAmount} is automatically locked in.`
                            : qrConfig.instructions || "Scan with any UPI app (GPay, PhonePe, Paytm) and complete payment."}
                        </p>

                        {/* Button to advance to Step 2 */}
                        <button
                          type="button"
                          onClick={() => setQrModalStep("SUBMIT")}
                          className="mt-4 w-full py-3.5 px-5 rounded-2xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold uppercase tracking-wider shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-98"
                        >
                          <span>I Have Scanned &amp; Paid</span>
                          <span>→</span>
                        </button>
                      </div>
                    )}
                  </>
                )}

                {/* STEP 2: ENTER TRANSACTION ID OR UPLOAD SCREENSHOT */}
                {qrModalStep === "SUBMIT" && (() => {
                  const txStatus = validateTransactionId(qrTransactionId);
                  const isTxIdProvided = qrTransactionId.trim().length > 0;
                  // Both fields are optional — only block submission if the customer typed an invalid UTR
                  const canSubmitQr = !isTxIdProvided || txStatus.isValid;

                  return (
                    <div className="mt-4 space-y-4">
                      <p className="text-xs text-gray-500 font-medium">
                        Enter your UPI Transaction ID (UTR) or attach payment screenshot (Optional):
                      </p>

                      {/* Transaction ID input */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-bold uppercase tracking-wider text-gray-700 block">
                            Transaction ID / UTR Number
                          </label>
                          <span className="text-[11px] font-semibold text-gray-400 lowercase">(optional)</span>
                        </div>

                        <div className="relative">
                          <input
                            type="text"
                            autoFocus
                            maxLength={12}
                            value={qrTransactionId}
                            onChange={(e) => setQrTransactionId(e.target.value.slice(0, 12))}
                            placeholder="e.g. 12-digit UTR (4239XXXXXXXX)"
                            className={`w-full px-4 py-2.5 pr-10 rounded-xl border text-xs font-mono outline-none transition-all ${
                              !isTxIdProvided
                                ? "border-gray-200 focus:border-purple-600 focus:ring-2 focus:ring-purple-600/10"
                                : txStatus.isValid
                                ? "border-emerald-500 bg-emerald-50/20 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/10 text-emerald-950"
                                : "border-red-400 bg-red-50/20 focus:border-red-500 focus:ring-2 focus:ring-red-500/10 text-red-950"
                            }`}
                          />
                          {isTxIdProvided && (
                            <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                              {txStatus.isValid ? (
                                <CheckCircle className="w-4 h-4 text-emerald-600" />
                              ) : (
                                <AlertCircle className="w-4 h-4 text-red-500" />
                              )}
                            </div>
                          )}
                        </div>

                        {/* Helper or validation message */}
                        {isTxIdProvided ? (
                          <p
                            className={`text-[11px] font-medium flex items-center gap-1 ${
                              txStatus.isValid ? "text-emerald-600" : "text-red-500"
                            }`}
                          >
                            {txStatus.isValid ? "✓ " : "⚠ "}
                            {txStatus.message}
                          </p>
                        ) : (
                          <p className="text-[10px] text-gray-400">
                            Standard UPI UTR is 12 digits (found on GPay, PhonePe, Paytm, or bank receipt). Optional, helps faster verification.
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="h-px bg-gray-200 flex-1" />
                        <span className="text-[10px] font-bold text-gray-400 uppercase">OR / AND</span>
                        <div className="h-px bg-gray-200 flex-1" />
                      </div>

                      {/* Screenshot upload */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-bold uppercase tracking-wider text-gray-700 block">
                            Payment Screenshot
                          </label>
                          <span className="text-[11px] font-semibold text-gray-400 lowercase">(optional)</span>
                        </div>
                        {qrScreenshotPreview ? (
                          <div className="relative rounded-2xl border border-gray-200 bg-gray-50 p-3 flex items-center gap-3">
                            <img
                              src={qrScreenshotPreview}
                              alt="Screenshot preview"
                              className="w-14 h-14 object-cover rounded-xl border border-gray-200 bg-white shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-bold text-gray-800 truncate">
                                {qrScreenshotFile?.name || "Screenshot"}
                              </p>
                              <p className="text-[10px] text-green-600 font-semibold mt-0.5">
                                ✓ Ready to upload
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setQrScreenshotFile(null);
                                setQrScreenshotPreview(null);
                              }}
                              className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-400 hover:text-red-500 transition-colors"
                              title="Remove screenshot"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <label className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-gray-200 rounded-2xl cursor-pointer hover:border-purple-400 hover:bg-purple-50/20 transition-all">
                            <UploadCloud className="w-7 h-7 text-purple-400 mb-1" />
                            <span className="text-xs font-bold text-gray-700">Upload payment screenshot (optional)</span>
                            <span className="text-[10px] text-gray-400 mt-0.5">PNG, JPG or WebP (Max 5MB)</span>
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                if (!file.type.startsWith("image/")) {
                                  toast.error("Please upload an image file");
                                  return;
                                }
                                setQrScreenshotFile(file);
                                setQrScreenshotPreview(URL.createObjectURL(file));
                              }}
                            />
                          </label>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="pt-2 flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setQrModalStep("SCAN")}
                          className="py-3 px-4 rounded-xl border border-gray-200 hover:bg-gray-50 text-xs font-bold text-gray-600 transition-colors"
                        >
                          Back
                        </button>
                        <button
                          type="button"
                          disabled={qrSubmitting || !canSubmitQr}
                          onClick={handleConfirmQrPayment}
                          className="flex-1 py-3 px-4 rounded-xl bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-bold uppercase tracking-wider text-white shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
                        >
                          {qrSubmitting ? (
                            <>Submitting Order…</>
                          ) : (
                            <>Confirm &amp; Place Order</>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* ================= SUCCESS MODAL ================= */}
      {createPortal(
        <AnimatePresence>
          {showSuccessModal && (
            <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/60 backdrop-blur-md"
              />

              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                className="relative w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-2xl z-10"
              >
                <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-green-50 text-green-500">
                  <CheckCircle className="h-10 w-10" />
                </div>

                <h2 className="text-2xl font-bold text-gray-900 mb-2">
                  Order Confirmed!
                </h2>
                <p className="text-gray-500 mb-8">
                  We've received your order and will begin processing it right away.
                </p>

                <button
                  onClick={() => navigate("/myorders", { replace: true })}
                  className="w-full rounded-full bg-[var(--theme-primary)] px-6 py-4 text-sm font-bold uppercase tracking-widest text-[var(--theme-primary-ink)] hover:bg-[var(--theme-primary-hover)] transition-all shadow-lg hover:shadow-xl hover:-translate-y-1 cursor-pointer"
                >
                  Track Order
                </button>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* Purchase Cancellation / Exit Intent Feedback Modal */}
      <CancellationFeedbackModal
        isOpen={feedbackModalOpen}
        onClose={() => {
          setFeedbackModalOpen(false);
          if (
            feedbackTriggerSource === "CHECKOUT_EXIT" ||
            feedbackTriggerSource === "COD_CHECKOUT_EXIT"
          ) {
            navigate("/", { replace: true });
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent("open-cart-drawer"));
            }, 150);
          }
        }}
        customerName={userProfile?.username || (address.house ? address.house : "")}
        customerEmail={userProfile?.email || ""}
        customerPhone={userProfile?.phone || ""}
        paymentMethod={paymentMethod.toUpperCase()}
        triggerSource={feedbackTriggerSource}
        orderId={feedbackOrderId}
        items={checkoutItems.map((item) => ({
          productId: item.productId,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          image: item.image,
          variant: item.selectedOptions && Object.keys(item.selectedOptions).length > 0
            ? Object.entries(item.selectedOptions).map(([k, v]) => `${k}: ${v}`).join(" / ")
            : undefined,
        }))}
        totalAmount={checkoutSubtotal + shippingCharge}
        onSubmitted={() => {
          if (
            feedbackTriggerSource === "CHECKOUT_EXIT" ||
            feedbackTriggerSource === "COD_CHECKOUT_EXIT"
          ) {
            navigate("/", { replace: true });
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent("open-cart-drawer"));
            }, 150);
          }
        }}
      />
    </div>
  );
};

export default CheckoutPage;
