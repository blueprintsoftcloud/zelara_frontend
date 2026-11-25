import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "../utils/api";
import toast from "react-hot-toast";
import { stripHtml } from "../utils/sanitizeHtml";
import { formatCurrency } from "../utils/currency";
import { calculateDiscountedPrice } from "../utils/product";
import {
  MagnifyingGlassIcon,
  UserCircleIcon,
  UserPlusIcon,
  ShoppingCartIcon,
  MapPinIcon,
  CreditCardIcon,
  CheckCircleIcon,
  TrashIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  PlusIcon,
  MinusIcon,
  DocumentTextIcon,
  TruckIcon,
  PhoneIcon,
  EnvelopeIcon,
  XMarkIcon,
  TicketIcon,
  HomeIcon,
  BuildingOffice2Icon,
  MapIcon,
  HashtagIcon,
  GlobeAmericasIcon,
  SparklesIcon,
  CheckIcon,
  ExclamationTriangleIcon,
  ArrowRightIcon,
  BuildingStorefrontIcon,
  ClockIcon,
  ArrowDownTrayIcon,
} from "@heroicons/react/24/outline";
import { CheckCircleIcon as CheckCircleSolid } from "@heroicons/react/24/solid";
import ShipOrderModal, { ShipOrderPayload } from "./ShipOrderModal";
import BulkInvoiceModal from "./BulkInvoiceModal";

interface RecentOrderInfo {
  id: string;
  shortId: string;
  createdAt: string;
  formattedTime: string;
  relativeTime: string;
  finalAmount: number;
  currency?: string;
  totalAmount?: number;
  orderStatus: string;
  paymentMethod: string;
  placedByAdmin: boolean;
  itemsCount: number;
  itemsSummary: string;
  customerName: string;
}

interface Customer {
  id: string;
  username: string;
  email: string | null;
  phone: string | null;
  emailVerifiedAt?: string | null;
  posActivationRequired?: boolean;
  recentAddress?: Address | null;
}

interface PlacedCustomerSummary {
  id: string;
  username: string;
  email: string | null;
  emailVerifiedAt: string | null;
  posActivationRequired: boolean;
}

interface ProductVariant {
  id: string;
  options: Record<string, string>;
  stock: number;
  priceOverride: number | null;
  discountOverride?: number | null;
  image?: string | null;
  secondaryImage?: string | null;
  images?: string[];
}

interface Product {
  id: string;
  name: string;
  code: string;
  image?: string;
  description?: string;
  price: number;
  discount?: number;
  salePrice?: number | null;
  basePrice?: number | null;
  stock: number;
  category?: { id: string; name: string };
  /** Active option combinations (Storage/Color, Weight, ...) this product is sold
   * in — see backend's ProductVariant. Empty for a plain single-SKU product. A
   * product with any entries here can't be added without picking one, same rule
   * the storefront's own add-to-cart already enforces (cart.controller.ts's cartAdd). */
  variants?: ProductVariant[];
}

interface CartItem {
  product: Product;
  variantId?: string | null;
  variantOptions?: Record<string, string> | null;
  /** Snapshot of the effective unit price at the moment this line was added —
   * either the picked variant's priceOverride or the product's own price. Stored
   * here (not recomputed from `products`) because the product list can page/search
   * away from what's already in the cart. */
  unitPrice: number;
  basePrice?: number;
  discountPercent?: number;
  /** Stock ceiling for the quantity stepper — the variant's own stock once one is
   * picked (Product.stock is meaningless for a variant product), else the product's. */
  maxStock: number;
  quantity: number;
}

interface Address {
  fullAddress: string;
  locality?: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
}

interface AppliedCoupon {
  couponId: string;
  code: string;
  discountType: "PERCENTAGE" | "FLAT";
  discountValue: number;
  discountAmount: number;
}

type PaymentMethod = "CASH" | "POD";

type Step = "customer" | "products" | "address" | "payment" | "confirm";

const STEPS: { id: Step; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>> }[] = [
  { id: "customer", label: "Customer", icon: UserCircleIcon },
  { id: "products", label: "Products", icon: ShoppingCartIcon },
  { id: "address", label: "Address", icon: MapPinIcon },
  { id: "payment", label: "Payment", icon: CreditCardIcon },
  { id: "confirm", label: "Confirm", icon: CheckCircleIcon },
];

const STEP_ORDER: Step[] = ["customer", "products", "address", "payment", "confirm"];

const EMAIL_FORMAT_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}$/;

const normalizePosPhone = (raw: string): string | null => {
  const cleaned = raw.replace(/[\s\-()+]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  // Qatar format (8 digits: 3xxxxxxx, 5xxxxxxx, 6xxxxxxx, 7xxxxxxx, etc.)
  if (/^[3-7][0-9]{7}$/.test(cleaned) || /^[0-9]{8}$/.test(cleaned)) return cleaned;
  if (/^974[0-9]{8}$/.test(cleaned)) return cleaned.slice(3);
  if (/^00974[0-9]{8}$/.test(cleaned)) return cleaned.slice(5);
  // UAE format fallback (9 digits)
  if (/^5[0-9]{8}$/.test(cleaned)) return cleaned;
  if (/^05[0-9]{8}$/.test(cleaned)) return cleaned.slice(1);
  if (/^9715[0-9]{8}$/.test(cleaned)) return cleaned.slice(3);
  if (/^009715[0-9]{8}$/.test(cleaned)) return cleaned.slice(5);
  return null;
};

const isValidPosEmail = (raw: string): boolean => {
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

const getEffectiveProductPrice = (product: Product, variant?: ProductVariant | null) => {
  const basePrice = Number(variant?.priceOverride ?? product.price ?? 0);
  const discountPercent = Number(variant?.discountOverride ?? product.discount ?? 0);
  const sellingPrice = discountPercent > 0
    ? calculateDiscountedPrice(basePrice, discountPercent)
    : basePrice;

  return { basePrice, sellingPrice, discountPercent };
};

// ─── Customer avatar / match-highlight helpers ──────────────────────────────
const AVATAR_PALETTE = [
  "bg-indigo-100 text-indigo-700",
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-violet-100 text-violet-700",
  "bg-cyan-100 text-cyan-700",
  "bg-orange-100 text-orange-700",
];

const avatarClass = (name: string) => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
};

const CustomerAvatar = ({ name, size = "sm" }: { name: string; size?: "sm" | "md" }) => (
  <div
    className={`shrink-0 rounded-full flex items-center justify-center font-bold ${avatarClass(name)} ${
      size === "md" ? "w-10 h-10 text-sm" : "w-8 h-8 text-xs"
    }`}
  >
    {name.trim().charAt(0).toUpperCase() || "?"}
  </div>
);

const HighlightMatch = ({ text, query }: { text: string; query: string }) => {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-indigo-100 text-indigo-700 rounded-sm px-0.5">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
};



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

// ─── Custom Product Variant Dropdown ────────────────────────────────────────
interface ProductVariantDropdownProps {
  variants: ProductVariant[];
  basePrice: number;
  productDiscount?: number;
  selectedVariantId: string;
  onSelect: (variantId: string) => void;
}

function ProductVariantDropdown({
  variants,
  basePrice,
  productDiscount,
  selectedVariantId,
  onSelect,
}: ProductVariantDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedVariant = variants.find(v => v.id === selectedVariantId);
  const selectedBase = Number(selectedVariant?.priceOverride ?? basePrice);
  const selectedDiscount = Number(selectedVariant?.discountOverride ?? productDiscount ?? 0);
  const selectedSellingPrice = selectedDiscount > 0
    ? calculateDiscountedPrice(selectedBase, selectedDiscount)
    : selectedBase;

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const formatVariantLabel = (options: Record<string, string>) => {
    const entries = Object.entries(options);
    if (entries.length === 0) return "Default Option";
    return entries.map(([k, val]) => `${k}: ${val}`).join(" / ");
  };

  return (
    <div className="relative mt-1 max-w-sm" ref={containerRef}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 rounded-xl border text-xs font-medium transition-all duration-200 text-left ${
          isOpen
            ? "border-indigo-500 bg-white ring-4 ring-indigo-500/15 shadow-sm"
            : "bg-gray-50/70 hover:bg-white hover:border-gray-300 border-gray-200 shadow-2xs"
        }`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {selectedVariant ? (
            <>
              <span className="font-semibold text-gray-800 truncate">
                {formatVariantLabel(selectedVariant.options)}
              </span>
              <span className="text-indigo-600 font-bold shrink-0">
                {formatCurrency(selectedSellingPrice)}
              </span>
              {selectedDiscount > 0 && (
                <span className="line-through text-gray-400 text-[10px] shrink-0">
                  {formatCurrency(selectedBase)}
                </span>
              )}
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold shrink-0 ${
                  selectedVariant.stock > 0
                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200/60"
                    : "bg-rose-50 text-rose-600 border border-rose-200/60"
                }`}
              >
                {selectedVariant.stock > 0 ? `${selectedVariant.stock} in stock` : "out of stock"}
              </span>
            </>
          ) : (
            <span className="text-gray-400 font-normal">Select option…</span>
          )}
        </div>
        <ChevronDownIcon
          className={`w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform duration-200 ${
            isOpen ? "rotate-180 text-indigo-600" : ""
          }`}
        />
      </button>

      {/* Popover Menu */}
      {isOpen && (
        <div className="absolute left-0 top-full mt-1.5 z-40 w-full min-w-[280px] bg-white border border-gray-100 rounded-2xl shadow-xl shadow-indigo-950/10 p-1.5 space-y-1 animate-fadeIn">
          <div className="max-h-56 overflow-y-auto space-y-1 pr-0.5">
            {variants.map(v => {
              const isSelected = v.id === selectedVariantId;
              const isOutOfStock = v.stock <= 0;
              const variantBasePrice = Number(v.priceOverride ?? basePrice);
              const variantDiscount = Number(v.discountOverride ?? productDiscount ?? 0);
              const variantSellingPrice = variantDiscount > 0
                ? calculateDiscountedPrice(variantBasePrice, variantDiscount)
                : variantBasePrice;

              return (
                <button
                  key={v.id}
                  type="button"
                  disabled={isOutOfStock}
                  onClick={() => {
                    onSelect(v.id);
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center justify-between gap-2.5 px-3 py-2 rounded-xl text-xs transition-all text-left group ${
                    isSelected
                      ? "bg-indigo-50/80 text-indigo-950 font-semibold border border-indigo-200/80 shadow-2xs"
                      : isOutOfStock
                      ? "opacity-45 cursor-not-allowed bg-gray-50/40 text-gray-400 border border-transparent"
                      : "text-gray-700 hover:bg-gray-50/80 hover:text-indigo-600 border border-transparent"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div
                      className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                        isSelected
                          ? "bg-indigo-600 text-white"
                          : "border border-gray-300 group-hover:border-indigo-400 bg-white"
                      }`}
                    >
                      {isSelected && <CheckIcon className="w-2.5 h-2.5 stroke-[3]" />}
                    </div>
                    <span className="truncate">{formatVariantLabel(v.options)}</span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`font-bold ${isSelected ? "text-indigo-700" : "text-gray-900"}`}>
                      {formatCurrency(variantSellingPrice)}
                    </span>
                    {variantDiscount > 0 && (
                      <span className="line-through text-gray-400 text-[10px]">
                        {formatCurrency(variantBasePrice)}
                      </span>
                    )}
                    <span
                      className={`px-1.5 py-0.5 rounded-md text-[10px] font-semibold shrink-0 ${
                        v.stock > 0
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-200/60"
                          : "bg-rose-50 text-rose-600 border border-rose-200/60"
                      }`}
                    >
                      {v.stock > 0 ? `${v.stock} in stock` : "out of stock"}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────
export default function AdminOrderPage() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState<Step>("customer");
  const [placing, setPlacing] = useState(false);
  const [placedOrder, setPlacedOrder] = useState<{ id: string; orderNumber?: string } | null>(null);

  // ── Post-order actions (invoice / ship) ──
  const [shipModalOpen, setShipModalOpen] = useState(false);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [shipSubmitting, setShipSubmitting] = useState(false);
  const [shippedInfo, setShippedInfo] = useState<{ deliveryPartnerName?: string; trackingId?: string } | null>(null);

  // ── Customer state ──
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [newCustomer, setNewCustomer] = useState({ username: "", phone: "", email: "" });

  // ── Duplicate customer detection & conflict modal state ──
  const [conflictCustomer, setConflictCustomer] = useState<Customer | null>(null);
  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const [conflictSubmitting, setConflictSubmitting] = useState(false);
  const [conflictReason, setConflictReason] = useState("");
  const [conflictTriggerSource, setConflictTriggerSource] = useState<"step1_next" | "place_order">("place_order");
  const [inlineMatchedCustomer, setInlineMatchedCustomer] = useState<Customer | null>(null);
  const checkNewCustomerDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Optional POS Counter Email Verification state ──
  const [placedCustomer, setPlacedCustomer] = useState<PlacedCustomerSummary | null>(null);
  const [posVerifyTarget, setPosVerifyTarget] = useState<{ id: string; username: string; email: string } | null>(null);
  const [posChallengeId, setPosChallengeId] = useState("");
  const [posOtp, setPosOtp] = useState("");
  const [posOtpTimer, setPosOtpTimer] = useState(0);
  const [posResendTimer, setPosResendTimer] = useState(0);
  const [posSending, setPosSending] = useState(false);
  const [posResending, setPosResending] = useState(false);
  const [posVerifying, setPosVerifying] = useState(false);
  const [posVerifyError, setPosVerifyError] = useState("");
  const [posVerifyDead, setPosVerifyDead] = useState(false);

  // ── 24-hour recent order detection state ──
  const [recentOrderWarning, setRecentOrderWarning] = useState<RecentOrderInfo | null>(null);
  const [recentOrderModalOpen, setRecentOrderModalOpen] = useState(false);
  const [recentOrderChecking, setRecentOrderChecking] = useState(false);
  const [bypassRecentOrder, setBypassRecentOrder] = useState(false);

  // ── Products state ──
  const [productSearch, setProductSearch] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productPage, setProductPage] = useState(1);
  const [productTotalPages, setProductTotalPages] = useState(1);
  const [cart, setCart] = useState<CartItem[]>([]);
  // Which variant is currently picked in each variant product's row — a draft choice
  // in the picker, separate from what's actually in the cart (see CartItem above).
  const [selectedVariantByProduct, setSelectedVariantByProduct] = useState<Record<string, string>>({});
  const productSearchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Coupon state ──
  const [couponCode, setCouponCode] = useState("");
  const [couponLoading, setCouponLoading] = useState(false);
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedCoupon | null>(null);

  // ── Address state ──
  const [address, setAddress] = useState<Address>({
    fullAddress: "",
    locality: "",
    city: "",
    state: "",
    zipCode: "",
    country: "Qatar",
  });
  const [stateDropdownOpen, setStateDropdownOpen] = useState(false);
  const [stateFilter, setStateFilter] = useState("");
  const stateDropdownRef = useRef<HTMLDivElement>(null);

  // ── Post office / locality selection state ──
  const [availableLocalities, setAvailableLocalities] = useState<string[]>([]);
  const [localityDropdownOpen, setLocalityDropdownOpen] = useState(false);
  const [localityFilter, setLocalityFilter] = useState("");
  const localityDropdownRef = useRef<HTMLDivElement>(null);

  const handlePoBoxChange = (value: string) =>
    setAddress((prev) => ({ ...prev, zipCode: value.slice(0, 20) }));

  const handleClearPoBox = () =>
    setAddress((prev) => ({ ...prev, zipCode: "" }));

  // ── Payment state ──
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("POD");
  const [paymentNote, setPaymentNote] = useState("");

  const resetPosVerify = useCallback(() => {
    setPosVerifyTarget(null);
    setPosChallengeId("");
    setPosOtp("");
    setPosOtpTimer(0);
    setPosResendTimer(0);
    setPosSending(false);
    setPosResending(false);
    setPosVerifying(false);
    setPosVerifyError("");
    setPosVerifyDead(false);
  }, []);

  useEffect(() => {
    if (posOtpTimer <= 0) return;
    const t = setInterval(() => {
      setPosOtpTimer((prev) => {
        if (prev <= 1) {
          setPosVerifyDead(true);
          setPosVerifyError("Verification code expired. Please request a new code.");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [posOtpTimer]);

  useEffect(() => {
    if (posResendTimer <= 0) return;
    const t = setInterval(() => setPosResendTimer((prev) => Math.max(0, prev - 1)), 1000);
    return () => clearInterval(t);
  }, [posResendTimer]);

  const markCustomerEmailVerified = useCallback(
    (customerSummary: { id: string; emailVerifiedAt?: string | null; posActivationRequired?: boolean }) => {
      const stamped = customerSummary.emailVerifiedAt ?? new Date().toISOString();
      setSelectedCustomer((prev) =>
        prev && prev.id === customerSummary.id
          ? { ...prev, emailVerifiedAt: stamped, posActivationRequired: false }
          : prev,
      );
      setPlacedCustomer((prev) =>
        prev && prev.id === customerSummary.id
          ? { ...prev, emailVerifiedAt: stamped, posActivationRequired: false }
          : prev,
      );
    },
    [],
  );

  const handleRequestPosVerifyOtp = async (target: {
    id: string;
    username: string;
    email: string | null;
  }) => {
    if (!target.email) {
      toast.error("Customer does not have an email address on record.");
      return;
    }
    setPosSending(true);
    setPosVerifyError("");
    setPosVerifyDead(false);
    try {
      const { data } = await api.post("/order/admin-order/pos-verify/request-otp", {
        customerId: target.id,
        email: target.email,
      });
      if (data?.alreadyVerified) {
        markCustomerEmailVerified({
          id: target.id,
          emailVerifiedAt: data.customer?.emailVerifiedAt ?? new Date().toISOString(),
          posActivationRequired: false,
        });
        resetPosVerify();
        toast.success("Customer email is already verified!");
        return;
      }
      setPosVerifyTarget({ id: target.id, username: target.username, email: data.email || target.email });
      setPosChallengeId(data.challengeId || "");
      setPosOtp("");
      setPosOtpTimer(data.expiresInSeconds ?? 300);
      setPosResendTimer(data.resendAfterSeconds ?? 120);
      toast.success(data.message || `Verification OTP sent to ${target.email}`);
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? "Failed to send verification OTP.";
      const retryAfter = err?.response?.data?.retryAfterSeconds;
      if (typeof retryAfter === "number" && retryAfter > 0) {
        setPosResendTimer(retryAfter);
      }
      setPosVerifyError(msg);
      toast.error(msg);
    } finally {
      setPosSending(false);
    }
  };

  const handleResendPosVerifyOtp = async () => {
    if (!posVerifyTarget || !posChallengeId || posResending || posResendTimer > 0) return;
    setPosResending(true);
    setPosVerifyError("");
    try {
      const { data } = await api.post("/order/admin-order/pos-verify/resend-otp", {
        customerId: posVerifyTarget.id,
        challengeId: posChallengeId,
      });
      setPosChallengeId(data.challengeId || posChallengeId);
      setPosOtp("");
      setPosOtpTimer(data.expiresInSeconds ?? 300);
      setPosResendTimer(data.resendAfterSeconds ?? 120);
      setPosVerifyDead(false);
      toast.success(data.message || "A new verification OTP was sent.");
    } catch (err: any) {
      const errData = err?.response?.data;
      const code = errData?.code;
      const msg = errData?.message ?? "Failed to resend verification OTP.";
      if (typeof errData?.retryAfterSeconds === "number" && errData.retryAfterSeconds > 0) {
        setPosResendTimer(errData.retryAfterSeconds);
      }
      if (
        code === "CHALLENGE_EXPIRED" ||
        code === "CHALLENGE_LOCKED" ||
        code === "CHALLENGE_INVALID" ||
        code === "CHALLENGE_MISSING"
      ) {
        setPosVerifyDead(true);
      }
      setPosVerifyError(msg);
      toast.error(msg);
    } finally {
      setPosResending(false);
    }
  };

  const handleVerifyPosOtp = async () => {
    if (!posVerifyTarget || !posChallengeId) return;
    const cleanOtp = posOtp.replace(/\D/g, "").slice(0, 6);
    if (cleanOtp.length !== 6) {
      setPosVerifyError("Enter the 6-digit OTP provided by the customer.");
      return;
    }
    setPosVerifying(true);
    setPosVerifyError("");
    try {
      const { data } = await api.post("/order/admin-order/pos-verify/verify-otp", {
        customerId: posVerifyTarget.id,
        challengeId: posChallengeId,
        otp: cleanOtp,
      });
      if (data?.customer) {
        markCustomerEmailVerified(data.customer);
      }
      toast.success(data?.message || "Customer email verified successfully!");
      resetPosVerify();
    } catch (err: any) {
      const errData = err?.response?.data;
      const code = errData?.code;
      const msg = errData?.message ?? "Invalid or expired OTP.";
      if (
        code === "CHALLENGE_EXPIRED" ||
        code === "CHALLENGE_LOCKED" ||
        code === "CHALLENGE_INVALID" ||
        code === "CHALLENGE_MISSING"
      ) {
        setPosVerifyDead(true);
      }
      setPosVerifyError(msg);
      toast.error(msg);
    } finally {
      setPosVerifying(false);
    }
  };

  const selectCustomer = (c: Customer) => {
    resetPosVerify();
    setSelectedCustomer(c);
    setNewCustomer({ username: "", phone: "", email: "" });
    setInlineMatchedCustomer(null);

    // Auto-fill recent ordered address if available
    if (c.recentAddress && c.recentAddress.fullAddress) {
      setAddress({
        fullAddress: c.recentAddress.fullAddress || "",
        locality: c.recentAddress.locality || "",
        city: c.recentAddress.city || "",
        state: c.recentAddress.state || "",
        zipCode: c.recentAddress.zipCode || "",
        country: "Qatar",
      });

      toast.success(`Auto-filled address from ${c.username}'s previous order!`, { id: "customer-address-autofill" });
    }
  };

  // ── Auto-check if entered phone or email matches an existing customer ──
  useEffect(() => {
    if (selectedCustomer) {
      setInlineMatchedCustomer(null);
      return;
    }
    const cleanPhone = newCustomer.phone.trim();
    const normalizedPhone = normalizePosPhone(cleanPhone);
    const cleanEmail = newCustomer.email.trim().toLowerCase();

    if (cleanPhone.length < 5 && (!cleanEmail || !cleanEmail.includes("@"))) {
      setInlineMatchedCustomer(null);
      return;
    }

    if (checkNewCustomerDebounce.current) {
      clearTimeout(checkNewCustomerDebounce.current);
    }

    checkNewCustomerDebounce.current = setTimeout(async () => {
      try {
        const { data } = await api.get("/order/admin-order/check-customer", {
          params: {
            ...(normalizedPhone ? { phone: normalizedPhone } : cleanPhone.length >= 5 ? { phone: cleanPhone } : {}),
            ...(cleanEmail.includes("@") ? { email: cleanEmail } : {}),
          },
        });
        if (data && data.exists && data.customer) {
          setInlineMatchedCustomer(data.customer);
        } else {
          setInlineMatchedCustomer(null);
        }
      } catch {
        // silent
      }
    }, 350);

    return () => {
      if (checkNewCustomerDebounce.current) clearTimeout(checkNewCustomerDebounce.current);
    };
  }, [selectedCustomer, newCustomer.phone, newCustomer.email]);

  useEffect(() => {
    setBypassRecentOrder(false);
    setRecentOrderWarning(null);
  }, [selectedCustomer?.id, newCustomer.phone, newCustomer.email]);

  useEffect(() => {
    if (currentStep !== "confirm" || bypassRecentOrder) return;
    const params: Record<string, string> = {};
    if (selectedCustomer?.id) {
      params.customerId = selectedCustomer.id;
    } else if (newCustomer.phone.trim()) {
      params.phone = normalizePosPhone(newCustomer.phone) ?? newCustomer.phone.trim();
    } else if (newCustomer.email.trim()) {
      params.email = newCustomer.email.trim().toLowerCase();
    }
    if (Object.keys(params).length === 0) return;

    api.get("/order/admin-order/check-recent-order", { params })
      .then(({ data }) => {
        if (data && data.hasRecentOrder && data.order) {
          setRecentOrderWarning(data.order);
        } else {
          setRecentOrderWarning(null);
        }
      })
      .catch(() => {
        // silent
      });
  }, [currentStep, selectedCustomer?.id, newCustomer.phone, newCustomer.email, bypassRecentOrder]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (stateDropdownRef.current && !stateDropdownRef.current.contains(e.target as Node)) {
        setStateDropdownOpen(false);
      }
      if (localityDropdownRef.current && !localityDropdownRef.current.contains(e.target as Node)) {
        setLocalityDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  // ─── Product fetch ────────────────────────────────────────────────────────
  const fetchProducts = useCallback(async (search: string, page: number) => {
    setProductsLoading(true);
    try {
      const { data } = await api.get("/order/admin-order/products", { params: { search, page, limit: 10 } });
      setProducts(data.products ?? []);
      setProductTotalPages(data.pagination?.totalPages ?? 1);
    } catch {
      toast.error("Failed to load products");
    } finally {
      setProductsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentStep === "products") fetchProducts(productSearch, productPage);
  }, [currentStep, productPage]);

  const handleProductSearch = (val: string) => {
    setProductSearch(val);
    if (productSearchDebounce.current) clearTimeout(productSearchDebounce.current);
    productSearchDebounce.current = setTimeout(() => {
      setProductPage(1);
      fetchProducts(val, 1);
    }, 350);
  };

  // ─── Cart helpers ─────────────────────────────────────────────────────────
  // A cart line is identified by (productId, variantId) — two different options of
  // the same product (e.g. 128GB vs 256GB) are separate lines, not merged into one,
  // same rule the storefront cart already follows (CartContext.tsx).
  const findCartLine = (productId: string, variantId?: string | null) =>
    cart.find(c => c.product.id === productId && String(c.variantId ?? "") === String(variantId ?? ""));

  const addToCart = (product: Product, variantId?: string | null) => {
    const hasVariants = (product.variants?.length ?? 0) > 0;
    const variant = variantId ? product.variants?.find(v => v.id === variantId) : undefined;
    if (hasVariants && !variant) {
      toast.error(`Select an option for "${product.name}" first`, { id: "admin-order-pick-variant" });
      return;
    }
    const { basePrice, sellingPrice, discountPercent } = getEffectiveProductPrice(product, variant);
    const unitPrice = sellingPrice;
    const maxStock = variant ? variant.stock : product.stock;
    setCart(prev => {
      const existing = prev.find(c => c.product.id === product.id && String(c.variantId ?? "") === String(variantId ?? ""));
      if (existing) {
        return prev.map(c =>
          c === existing
            ? { ...c, unitPrice, basePrice, discountPercent, maxStock, quantity: Math.min(c.quantity + 1, maxStock) }
            : c,
        );
      }
      return [
        ...prev,
        { product, variantId: variant?.id ?? null, variantOptions: variant?.options ?? null, unitPrice, basePrice, discountPercent, maxStock, quantity: 1 },
      ];
    });
  };

  const updateQty = (productId: string, variantId: string | null | undefined, qty: number, maxStock: number) => {
    if (qty < 1) { removeFromCart(productId, variantId); return; }
    setCart(prev =>
      prev.map(c =>
        c.product.id === productId && String(c.variantId ?? "") === String(variantId ?? "")
          ? { ...c, quantity: Math.min(qty, maxStock) }
          : c,
      ),
    );
  };

  const removeFromCart = (productId: string, variantId?: string | null) => {
    setCart(prev => prev.filter(c => !(c.product.id === productId && String(c.variantId ?? "") === String(variantId ?? ""))));
    setSelectedVariantByProduct(prev => {
      if (prev[productId]) {
        const next = { ...prev };
        delete next[productId];
        return next;
      }
      return prev;
    });
  };

  const cartTotal = cart.reduce((sum, c) => sum + c.unitPrice * c.quantity, 0);
  const orderTotal = Math.max(cartTotal - (appliedCoupon?.discountAmount ?? 0), 0);

  // A coupon's discount was computed against the subtotal at the moment it was applied —
  // if the cart changes afterwards that preview is stale, so drop it and make the admin
  // re-apply. The backend re-validates independently at final submission regardless.
  useEffect(() => {
    setAppliedCoupon(null);
  }, [cart]);

  // ─── Coupon ───────────────────────────────────────────────────────────────
  const handleApplyCoupon = async () => {
    const code = couponCode.trim();
    if (!code) return;
    setCouponLoading(true);
    try {
      const { data } = await api.post("/coupon/validate", { code, orderAmount: cartTotal });
      setAppliedCoupon({
        couponId: data.couponId,
        code: data.code,
        discountType: data.discountType,
        discountValue: data.discountValue,
        discountAmount: data.discountAmount,
      });
      toast.success(
        data.discountType === "PERCENTAGE"
          ? `Coupon applied: ${data.discountValue}% off`
          : `Coupon applied: QAR ${data.discountAmount.toLocaleString("en-QA")} off`
      );
    } catch (err: any) {
      toast.error(err?.response?.data?.message ?? "Invalid or expired coupon");
    } finally {
      setCouponLoading(false);
    }
  };

  const handleRemoveCoupon = () => {
    setAppliedCoupon(null);
    setCouponCode("");
  };

  // ─── Validation helpers ───────────────────────────────────────────────────
  const trimmedNewCustomerName = newCustomer.username.trim();
  const isNewCustomerNameValid = trimmedNewCustomerName.length >= 2 && trimmedNewCustomerName.length <= 80;
  const normalizedNewCustomerPhone = normalizePosPhone(newCustomer.phone);
  const isNewCustomerPhoneValid = normalizedNewCustomerPhone !== null;
  const isNewCustomerEmailValid = isValidPosEmail(newCustomer.email);

  const canProceed = (): boolean => {
    if (currentStep === "customer") {
      if (selectedCustomer) return true;
      return isNewCustomerNameValid && isNewCustomerPhoneValid && isNewCustomerEmailValid;
    }
    if (currentStep === "products") return cart.length > 0;
    if (currentStep === "address") {
      return true;
    }
    return true;
  };

  const goNext = () => {
    if (currentStep === "customer" && !selectedCustomer) {
      if (!isNewCustomerNameValid) {
        toast.error("Enter a valid customer name (at least 2 characters)");
        return;
      }
      if (!isNewCustomerPhoneValid) {
        toast.error("Enter a valid mobile number (e.g. +974 3xxxxxxx or +974 5xxxxxxx)");
        return;
      }
      if (!isNewCustomerEmailValid) {
        toast.error("Enter a valid email address");
        return;
      }
      if (inlineMatchedCustomer) {
        setConflictCustomer(inlineMatchedCustomer);
        setConflictReason("This phone number or email is already registered to an existing customer.");
        setConflictTriggerSource("step1_next");
        setConflictModalOpen(true);
        return;
      }
    }
    const idx = STEP_ORDER.indexOf(currentStep);
    if (idx < STEP_ORDER.length - 1) setCurrentStep(STEP_ORDER[idx + 1]);
  };

  const goBack = () => {
    const idx = STEP_ORDER.indexOf(currentStep);
    if (idx > 0) setCurrentStep(STEP_ORDER[idx - 1]);
  };

  // ─── Place order ──────────────────────────────────────────────────────────
  const handlePlaceOrder = async (bypassWarning = false) => {
    // If not bypassing, check if customer already placed an order in last 24h
    if (!bypassWarning && !bypassRecentOrder) {
      if (recentOrderWarning) {
        setRecentOrderModalOpen(true);
        return;
      }

      setRecentOrderChecking(true);
      try {
        const params: Record<string, string> = {};
        if (selectedCustomer?.id) {
          params.customerId = selectedCustomer.id;
        } else if (newCustomer.phone.trim()) {
          params.phone = normalizePosPhone(newCustomer.phone) ?? newCustomer.phone.trim();
        } else if (newCustomer.email.trim()) {
          params.email = newCustomer.email.trim().toLowerCase();
        }

        if (Object.keys(params).length > 0) {
          const { data } = await api.get("/order/admin-order/check-recent-order", { params });
          if (data && data.hasRecentOrder && data.order) {
            setRecentOrderWarning(data.order);
            setRecentOrderModalOpen(true);
            setRecentOrderChecking(false);
            return;
          }
        }
      } catch (checkErr) {
        console.warn("Recent order pre-check failed, fallback to place check", checkErr);
      } finally {
        setRecentOrderChecking(false);
      }
    }

    setPlacing(true);
    try {
      const body: Record<string, unknown> = {
        items: cart.map(c => ({ productId: c.product.id, variantId: c.variantId ?? undefined, quantity: c.quantity })),
        address,
        paymentMethod,
        ...(paymentNote.trim() ? { paymentNote: paymentNote.trim() } : {}),
        ...(appliedCoupon ? { couponId: appliedCoupon.couponId } : {}),
        ...(bypassWarning || bypassRecentOrder ? { bypassRecentOrderWarning: true } : {}),
      };
      if (selectedCustomer) {
        body.customerId = selectedCustomer.id;
      } else {
        if (!isNewCustomerNameValid || !normalizedNewCustomerPhone || !isNewCustomerEmailValid) {
          toast.error("Valid customer name, mobile number, and email address are required");
          setPlacing(false);
          return;
        }
        body.newCustomer = {
          username: trimmedNewCustomerName,
          phone: normalizedNewCustomerPhone,
          email: newCustomer.email.trim().toLowerCase(),
        };
      }
      const { data } = await api.post("/order/admin-order/place", body);
      toast.success("Order placed successfully!");
      setConflictModalOpen(false);
      setConflictCustomer(null);
      setRecentOrderModalOpen(false);
      setRecentOrderWarning(null);
      setBypassRecentOrder(false);
      setPlacedOrder({ id: data.order?.id ?? data.orderId ?? "—" });
      setPlacedCustomer(
        data.customer
          ? {
              id: data.customer.id,
              username: data.customer.username,
              email: data.customer.email ?? null,
              emailVerifiedAt: data.customer.emailVerifiedAt ?? null,
              posActivationRequired: Boolean(data.customer.posActivationRequired),
            }
          : null,
      );
      resetPosVerify();
    } catch (err: any) {
      if (
        err?.response?.data?.code === "RECENT_ORDER_EXISTS_24H" &&
        err?.response?.data?.recentOrder
      ) {
        setRecentOrderWarning(err.response.data.recentOrder);
        setRecentOrderModalOpen(true);
        return;
      }
      if (
        (err?.response?.data?.code === "CUSTOMER_ALREADY_EXISTS" || err?.response?.status === 409) &&
        err?.response?.data?.existingCustomer
      ) {
        setConflictCustomer(err.response.data.existingCustomer);
        setConflictReason(err.response.data.message || "A customer with this phone number or email already exists.");
        setConflictTriggerSource("place_order");
        setConflictModalOpen(true);
        return;
      }
      const fieldErrors = err?.response?.data?.errors;
      const firstFieldErr = fieldErrors
        ? Object.values(fieldErrors).flat().find((item): item is string => typeof item === "string" && item.length > 0)
        : undefined;
      toast.error(firstFieldErr ?? err?.response?.data?.message ?? "Failed to place order");
    } finally {
      setPlacing(false);
    }
  };

  // ─── Action when admin confirms using the existing customer inside the conflict modal ───
  const handleSelectConflictCustomerAction = async () => {
    if (!conflictCustomer) return;

    setSelectedCustomer(conflictCustomer);
    setNewCustomer({ username: "", phone: "", email: "" });
    setInlineMatchedCustomer(null);

    if (conflictTriggerSource === "step1_next" || currentStep === "customer") {
      setConflictModalOpen(false);
      setConflictCustomer(null);
      setCurrentStep("products");
      toast.success(`Selected customer: ${conflictCustomer.username}`);
      return;
    }

    // Direct place order from Confirm step
    setConflictSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        customerId: conflictCustomer.id,
        items: cart.map(c => ({ productId: c.product.id, variantId: c.variantId ?? undefined, quantity: c.quantity })),
        address,
        paymentMethod,
        ...(paymentNote.trim() ? { paymentNote: paymentNote.trim() } : {}),
        ...(appliedCoupon ? { couponId: appliedCoupon.couponId } : {}),
        ...(bypassRecentOrder ? { bypassRecentOrderWarning: true } : {}),
      };
      const { data } = await api.post("/order/admin-order/place", body);
      toast.success(`Order placed successfully for ${conflictCustomer.username}!`);
      setConflictModalOpen(false);
      setConflictCustomer(null);
      setRecentOrderModalOpen(false);
      setRecentOrderWarning(null);
      setBypassRecentOrder(false);
      setPlacedOrder({ id: data.order?.id ?? data.orderId ?? "—" });
      setPlacedCustomer(
        data.customer
          ? {
              id: data.customer.id,
              username: data.customer.username,
              email: data.customer.email ?? null,
              emailVerifiedAt: data.customer.emailVerifiedAt ?? null,
              posActivationRequired: Boolean(data.customer.posActivationRequired),
            }
          : null,
      );
      resetPosVerify();
    } catch (err: any) {
      if (
        err?.response?.data?.code === "RECENT_ORDER_EXISTS_24H" &&
        err?.response?.data?.recentOrder
      ) {
        setConflictModalOpen(false);
        setRecentOrderWarning(err.response.data.recentOrder);
        setRecentOrderModalOpen(true);
        return;
      }
      toast.error(err?.response?.data?.message ?? "Failed to place order");
    } finally {
      setConflictSubmitting(false);
    }
  };

  // ─── Ship order (optional, right after placement) ────────────────────────
  const handleShipOrder = async (payload: ShipOrderPayload) => {
    if (!placedOrder) return;
    setShipSubmitting(true);
    try {
      const { data } = await api.put(`/order/update/${placedOrder.id}`, {
        orderStatus: "SHIPPED",
        ...payload,
      });
      setShippedInfo({
        deliveryPartnerName: data.order?.deliveryPartnerName,
        trackingId: data.order?.trackingId,
      });
      toast.success("Order shipped and customer notified!");
      setShipModalOpen(false);
    } catch (err: any) {
      toast.error(err?.response?.data?.message ?? "Failed to ship order");
    } finally {
      setShipSubmitting(false);
    }
  };

  const handleResetForNewOrder = () => {
    setPlacedOrder(null);
    setPlacedCustomer(null);
    resetPosVerify();
    setShippedInfo(null);
    setShipModalOpen(false);
    setInvoiceModalOpen(false);
    setConflictCustomer(null);
    setConflictModalOpen(false);
    setConflictSubmitting(false);
    setConflictReason("");
    setInlineMatchedCustomer(null);
    setCurrentStep("customer");
    setSelectedCustomer(null);
    setNewCustomer({ username: "", phone: "", email: "" });
    setCart([]);
    setSelectedVariantByProduct({});
    setCouponCode("");
    setAppliedCoupon(null);
    setAddress({ fullAddress: "", locality: "", city: "", state: "", zipCode: "", country: "Qatar" });
    setPaymentMethod("POD");
    setPaymentNote("");
    setRecentOrderWarning(null);
    setRecentOrderModalOpen(false);
    setRecentOrderChecking(false);
    setBypassRecentOrder(false);
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  const stepIndex = STEP_ORDER.indexOf(currentStep);

  // ─ Success screen ─
  if (placedOrder) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-8">
        <div className="max-w-md w-full text-center bg-white rounded-2xl shadow-lg p-10">
          <CheckCircleSolid className="w-20 h-20 text-green-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-gray-800 mb-2">Order Placed!</h2>
          <p className="text-gray-500 text-sm mb-1">Order ID:</p>
          <p className="font-mono text-indigo-600 font-semibold text-sm break-all mb-6">{placedOrder.id}</p>

          {shippedInfo && (
            <div className="flex items-center gap-3 p-4 mb-5 bg-blue-50 border border-blue-200 rounded-xl text-left">
              <TruckIcon className="w-6 h-6 text-blue-600 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-blue-800">Order shipped</p>
                <p className="text-xs text-blue-600">
                  {shippedInfo.deliveryPartnerName ?? "Handled without a courier"}
                  {shippedInfo.trackingId ? ` · ${shippedInfo.trackingId}` : ""}
                </p>
              </div>
            </div>
          )}

          {/* Optional POS Counter Email Ownership Verification */}
          {placedCustomer && placedCustomer.email && (
            placedCustomer.emailVerifiedAt && !placedCustomer.posActivationRequired ? (
              <div className="flex items-center gap-2.5 p-3 mb-5 bg-emerald-50 border border-emerald-200 rounded-xl text-left">
                <CheckCircleSolid className="w-5 h-5 text-emerald-600 shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-bold text-emerald-900">Customer Email Verified</p>
                  <p className="text-[11px] text-emerald-700 truncate">
                    {placedCustomer.email} · Online storefront login active
                  </p>
                </div>
              </div>
            ) : (
              <div className="p-4 mb-5 bg-amber-50/80 border border-amber-200 rounded-xl text-left space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-amber-950">
                      Customer Email Pending Activation (Optional)
                    </p>
                    <p className="text-[11px] text-amber-800 mt-0.5 leading-relaxed">
                      Order is complete. You may optionally verify <span className="font-semibold">{placedCustomer.email}</span> now so{" "}
                      <span className="font-semibold">{placedCustomer.username}</span> can sign in online.
                    </p>
                  </div>
                </div>

                {posVerifyTarget?.id === placedCustomer.id ? (
                  <div className="space-y-2.5 pt-1 border-t border-amber-200/70">
                    <div className="flex items-center justify-between text-[11px] text-amber-900">
                      <span>Enter 6-digit OTP sent to customer email</span>
                      {posOtpTimer > 0 && (
                        <span className="font-bold">Expires in {posOtpTimer}s</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={posOtp}
                        onChange={(e) => {
                          setPosOtp(e.target.value.replace(/\D/g, "").slice(0, 6));
                          if (posVerifyError) setPosVerifyError("");
                        }}
                        disabled={posVerifying || posVerifyDead}
                        placeholder="6-digit OTP"
                        className="flex-1 h-9 px-3 text-sm font-bold tracking-widest bg-white border border-amber-300 rounded-lg focus:outline-none focus:border-indigo-500"
                      />
                      <button
                        type="button"
                        onClick={handleVerifyPosOtp}
                        disabled={posVerifying || posVerifyDead || posOtp.length !== 6}
                        className="px-3.5 h-9 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition disabled:opacity-50 cursor-pointer"
                      >
                        {posVerifying ? "Verifying…" : "Verify"}
                      </button>
                    </div>
                    {posVerifyError && (
                      <p className="text-[11px] font-semibold text-rose-700">{posVerifyError}</p>
                    )}
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      {posVerifyDead ? (
                        <button
                          type="button"
                          onClick={() => handleRequestPosVerifyOtp(placedCustomer)}
                          disabled={posSending}
                          className="font-bold text-indigo-700 underline cursor-pointer"
                        >
                          {posSending ? "Sending…" : "Request New OTP"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handleResendPosVerifyOtp}
                          disabled={posResending || posResendTimer > 0}
                          className="font-bold text-amber-900 hover:underline disabled:text-amber-600/60 disabled:no-underline cursor-pointer"
                        >
                          {posResending
                            ? "Sending…"
                            : posResendTimer > 0
                              ? `Resend OTP in ${posResendTimer}s`
                              : "Resend OTP"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={resetPosVerify}
                        className="text-gray-500 hover:text-gray-700 font-medium cursor-pointer"
                      >
                        Skip for now
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleRequestPosVerifyOtp(placedCustomer)}
                    disabled={posSending}
                    className="w-full py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold transition disabled:opacity-50 cursor-pointer"
                  >
                    {posSending ? "Sending OTP…" : "Verify Email at Counter (Optional)"}
                  </button>
                )}
              </div>
            )
          )}

          {/* Action Buttons */}
          <div className="space-y-3 mb-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setInvoiceModalOpen(true)}
                className="inline-flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-xl font-semibold text-sm transition-colors shadow-xs cursor-pointer active:scale-98"
              >
                <ArrowDownTrayIcon className="w-4 h-4" />
                Download Invoice
              </button>
              <button
                type="button"
                onClick={() => window.open(`/invoice/${placedOrder.id}`, "_blank")}
                className="inline-flex items-center justify-center gap-2 bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 px-4 py-2.5 rounded-xl font-semibold text-sm transition-colors cursor-pointer active:scale-98"
              >
                <DocumentTextIcon className="w-4 h-4" />
                View Invoice
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setShipModalOpen(true)}
                disabled={!!shippedInfo}
                className={`inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition-colors cursor-pointer ${
                  shippedInfo
                    ? "bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-700 text-white shadow-xs active:scale-98"
                }`}
              >
                <TruckIcon className="w-4 h-4" />
                {shippedInfo ? "Dispatched" : "Ship Order"}
              </button>
              <button
                type="button"
                onClick={handleResetForNewOrder}
                className="inline-flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-4 py-2.5 rounded-xl font-semibold text-sm transition-colors cursor-pointer shadow-xs active:scale-98"
              >
                <PlusIcon className="w-4 h-4" />
                + New Order
              </button>
            </div>
          </div>
        </div>

        <ShipOrderModal
          order={shipModalOpen ? placedOrder : null}
          submitting={shipSubmitting}
          onClose={() => setShipModalOpen(false)}
          onConfirm={handleShipOrder}
        />

        {invoiceModalOpen && placedOrder && (
          <BulkInvoiceModal
            orderIds={[placedOrder.id]}
            onClose={() => setInvoiceModalOpen(false)}
            onSuccess={() => {}}
          />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-gray-50 flex flex-col justify-between">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 sm:px-8 py-5 tracking-tight shrink-0">
        <h1 className="text-3xl font-bold text-gray-900">Place Order on Behalf of Customer</h1>
        <p className="text-sm text-gray-500 mt-0.5">Walk-in / cash counter order entry</p>
      </div>

      {/* Step indicator */}
      <div className="bg-white border-b border-gray-100 px-4 sm:px-8 py-4 shrink-0">
        <ol className="flex items-center gap-0 overflow-x-auto">
          {STEPS.map((step, i) => {
            const done = STEP_ORDER.indexOf(step.id) < stepIndex;
            const active = step.id === currentStep;
            return (
              <li key={step.id} className="flex items-center shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    if (done) setCurrentStep(step.id);
                  }}
                  disabled={!done && !active}
                  className={`flex flex-col sm:flex-row items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors
                    ${active ? "text-indigo-700 bg-indigo-50" : done ? "text-green-700 cursor-pointer hover:bg-green-50" : "text-gray-400 cursor-default"}`}
                >
                  {done ? (
                    <CheckCircleSolid className="w-5 h-5 text-green-500 shrink-0" />
                  ) : (
                    <step.icon className={`w-5 h-5 shrink-0 ${active ? "text-indigo-600" : "text-gray-400"}`} />
                  )}
                  {step.label}
                </button>
                {i < STEPS.length - 1 && <ChevronRightIcon className="w-4 h-4 text-gray-300 mx-1 shrink-0" />}
              </li>
            );
          })}
        </ol>
      </div>

      {/* Body */}
      <div className="flex-1 w-full px-4 sm:px-8 py-8 space-y-6">

        {/* ── STEP 1: Customer ── */}
        {currentStep === "customer" && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-5">
            <div>
              <h2 className="text-lg font-bold text-gray-800">Customer Details</h2>
              <p className="text-xs text-gray-400 mt-0.5">Enter customer name, mobile number, and email address for this order</p>
            </div>

            {selectedCustomer ? (
              /* Selected Customer Card + Optional Counter Email Verification */
              <div className="max-w-lg space-y-3 animate-fadeIn">
                <div className="flex items-center justify-between gap-3 px-4 py-3.5 bg-emerald-50 border border-emerald-200 rounded-xl">
                  <div className="flex items-center gap-3 min-w-0">
                    <CustomerAvatar name={selectedCustomer.username} size="md" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-emerald-900 truncate">{selectedCustomer.username}</p>
                        <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded">
                          Existing Customer
                        </span>
                        {selectedCustomer.emailVerifiedAt && !selectedCustomer.posActivationRequired ? (
                          <span className="text-[10px] font-bold uppercase tracking-wider bg-green-100 text-green-800 px-1.5 py-0.5 rounded">
                            Email Verified
                          </span>
                        ) : selectedCustomer.email ? (
                          <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                            Pending Activation
                          </span>
                        ) : null}
                      </div>
                      <p className="text-xs text-emerald-700 mt-0.5">
                        {selectedCustomer.phone ?? "No phone"} {selectedCustomer.email ? `· ${selectedCustomer.email}` : ""}
                      </p>
                      {selectedCustomer.recentAddress?.fullAddress && (
                        <p className="text-[11px] text-emerald-600 flex items-center gap-1 mt-1 font-medium">
                          <MapPinIcon className="w-3 h-3 text-emerald-600 shrink-0" />
                          <span>Address auto-filled ({selectedCustomer.recentAddress.city}, {selectedCustomer.recentAddress.state})</span>
                        </p>
                      )}
                      {selectedCustomer.email &&
                        (!selectedCustomer.emailVerifiedAt || selectedCustomer.posActivationRequired) &&
                        posVerifyTarget?.id !== selectedCustomer.id && (
                          <button
                            type="button"
                            onClick={() => handleRequestPosVerifyOtp(selectedCustomer)}
                            disabled={posSending}
                            className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold transition disabled:opacity-50 cursor-pointer"
                          >
                            <EnvelopeIcon className="w-3.5 h-3.5" />
                            {posSending ? "Sending OTP…" : "Verify Email at Counter (Optional)"}
                          </button>
                        )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      resetPosVerify();
                      setSelectedCustomer(null);
                      setNewCustomer({ username: "", phone: "", email: "" });
                      setInlineMatchedCustomer(null);
                      setAddress({ fullAddress: "", city: "", state: "", zipCode: "", country: "Qatar" });
                    }}
                    className="shrink-0 text-xs font-semibold text-gray-600 hover:text-red-600 hover:bg-white transition px-2.5 py-1.5 rounded-lg border border-gray-200/80 bg-white/60 cursor-pointer"
                  >
                    Change
                  </button>
                </div>

                {posVerifyTarget?.id === selectedCustomer.id && (
                  <div className="p-4 bg-amber-50/90 border border-amber-200 rounded-xl space-y-2.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-bold text-amber-950">
                        Counter Verification OTP sent to {posVerifyTarget.email}
                      </span>
                      {posOtpTimer > 0 && (
                        <span className="text-[11px] font-bold text-amber-800">
                          {posOtpTimer}s left
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={posOtp}
                        onChange={(e) => {
                          setPosOtp(e.target.value.replace(/\D/g, "").slice(0, 6));
                          if (posVerifyError) setPosVerifyError("");
                        }}
                        disabled={posVerifying || posVerifyDead}
                        placeholder="Enter 6-digit OTP"
                        className="flex-1 h-10 px-3 text-sm font-bold tracking-widest bg-white border border-amber-300 rounded-lg focus:outline-none focus:border-indigo-500"
                      />
                      <button
                        type="button"
                        onClick={handleVerifyPosOtp}
                        disabled={posVerifying || posVerifyDead || posOtp.length !== 6}
                        className="px-4 h-10 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition disabled:opacity-50 cursor-pointer"
                      >
                        {posVerifying ? "Verifying…" : "Verify Email"}
                      </button>
                    </div>
                    {posVerifyError && (
                      <p className="text-[11px] font-semibold text-rose-700">{posVerifyError}</p>
                    )}
                    <div className="flex items-center justify-between text-[11px]">
                      {posVerifyDead ? (
                        <button
                          type="button"
                          onClick={() => handleRequestPosVerifyOtp(selectedCustomer)}
                          disabled={posSending}
                          className="font-bold text-indigo-700 underline cursor-pointer"
                        >
                          {posSending ? "Sending…" : "Send New OTP"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handleResendPosVerifyOtp}
                          disabled={posResending || posResendTimer > 0}
                          className="font-bold text-amber-900 hover:underline disabled:text-amber-600/60 disabled:no-underline cursor-pointer"
                        >
                          {posResending
                            ? "Sending…"
                            : posResendTimer > 0
                              ? `Resend OTP in ${posResendTimer}s`
                              : "Resend OTP"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={resetPosVerify}
                        className="text-gray-600 hover:text-gray-800 font-semibold cursor-pointer"
                      >
                        Close (Continue Without Verifying)
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Customer Form */
              <div className="max-w-lg space-y-4 animate-fadeIn">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-xs font-bold text-gray-700 uppercase tracking-wider">
                      <UserCircleIcon className="w-3.5 h-3.5 text-indigo-600" />
                      Full Name <span className="text-rose-500 font-bold normal-case">*</span>
                    </label>
                    {isNewCustomerNameValid && (
                      <span className="text-[11px] font-semibold text-emerald-600 flex items-center gap-1 animate-fadeIn">
                        <CheckCircleSolid className="w-3.5 h-3.5" /> Valid
                      </span>
                    )}
                  </div>
                  <div className="relative flex items-center bg-gray-50/60 hover:bg-gray-50/20 focus-within:bg-white border border-gray-200 hover:border-gray-300 focus-within:border-indigo-500 rounded-xl shadow-xs focus-within:shadow-md focus-within:ring-4 focus-within:ring-indigo-500/15 transition-all duration-200 group">
                    <UserCircleIcon className="w-4 h-4 ml-3.5 text-gray-400 group-focus-within:text-indigo-600 transition-colors pointer-events-none shrink-0" />
                    <input
                      type="text"
                      required
                      autoFocus
                      placeholder="Customer name"
                      value={newCustomer.username}
                      onChange={e => setNewCustomer(p => ({ ...p, username: e.target.value }))}
                      className="w-full pl-3 pr-9 h-11 text-sm font-medium text-gray-900 placeholder:text-gray-400 placeholder:font-normal bg-transparent focus:outline-none"
                    />
                    {newCustomer.username && (
                      <button
                        type="button"
                        onClick={() => setNewCustomer(p => ({ ...p, username: "" }))}
                        className="absolute right-3 text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-200/50 transition-colors cursor-pointer"
                        title="Clear name"
                      >
                        <XMarkIcon className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  {newCustomer.username.trim().length > 0 && !isNewCustomerNameValid && (
                    <p className="text-[11px] text-rose-500 font-medium">Enter 2–80 characters</p>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-1.5 text-xs font-bold text-gray-700 uppercase tracking-wider">
                        <PhoneIcon className="w-3.5 h-3.5 text-indigo-600" />
                        Phone <span className="text-rose-500 font-bold normal-case">*</span>
                      </label>
                      {isNewCustomerPhoneValid && (
                        <span className="text-[11px] font-semibold text-emerald-600 flex items-center gap-1 animate-fadeIn">
                          <CheckCircleSolid className="w-3.5 h-3.5" /> Valid
                        </span>
                      )}
                    </div>
                    <div className="relative flex items-center bg-gray-50/60 hover:bg-gray-50/20 focus-within:bg-white border border-gray-200 hover:border-gray-300 focus-within:border-indigo-500 rounded-xl shadow-xs focus-within:shadow-md focus-within:ring-4 focus-within:ring-indigo-500/15 transition-all duration-200 group">
                      <PhoneIcon className="w-4 h-4 ml-3.5 text-gray-400 group-focus-within:text-indigo-600 transition-colors pointer-events-none shrink-0" />
                      <input
                        type="tel"
                        required
                        placeholder="+974 3X XXX XXX"
                        value={newCustomer.phone}
                        onChange={e => setNewCustomer(p => ({ ...p, phone: e.target.value }))}
                        className="w-full pl-3 pr-9 h-11 text-sm font-medium text-gray-900 placeholder:text-gray-400 placeholder:font-normal bg-transparent focus:outline-none"
                      />
                      {newCustomer.phone && (
                        <button
                          type="button"
                          onClick={() => setNewCustomer(p => ({ ...p, phone: "" }))}
                          className="absolute right-3 text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-200/50 transition-colors cursor-pointer"
                          title="Clear phone"
                        >
                          <XMarkIcon className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    {newCustomer.phone.trim().length > 0 && !isNewCustomerPhoneValid && (
                      <p className="text-[11px] text-rose-500 font-medium">Enter a valid mobile number (+974 XXXXXXXX or +971 5xxxxxxxx)</p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-1.5 text-xs font-bold text-gray-700 uppercase tracking-wider">
                        <EnvelopeIcon className="w-3.5 h-3.5 text-indigo-600" />
                        Email <span className="text-rose-500 font-bold normal-case">*</span>
                      </label>
                      {isNewCustomerEmailValid && (
                        <span className="text-[11px] font-semibold text-emerald-600 flex items-center gap-1 animate-fadeIn">
                          <CheckCircleSolid className="w-3.5 h-3.5" /> Valid
                        </span>
                      )}
                    </div>
                    <div className="relative flex items-center bg-gray-50/60 hover:bg-gray-50/20 focus-within:bg-white border border-gray-200 hover:border-gray-300 focus-within:border-indigo-500 rounded-xl shadow-xs focus-within:shadow-md focus-within:ring-4 focus-within:ring-indigo-500/15 transition-all duration-200 group">
                      <EnvelopeIcon className="w-4 h-4 ml-3.5 text-gray-400 group-focus-within:text-indigo-600 transition-colors pointer-events-none shrink-0" />
                      <input
                        type="email"
                        required
                        placeholder="customer@email.com"
                        value={newCustomer.email}
                        onChange={e => setNewCustomer(p => ({ ...p, email: e.target.value.toLowerCase() }))}
                        className="w-full pl-3 pr-9 h-11 text-sm font-medium text-gray-900 placeholder:text-gray-400 placeholder:font-normal bg-transparent focus:outline-none"
                      />
                      {newCustomer.email && (
                        <button
                          type="button"
                          onClick={() => setNewCustomer(p => ({ ...p, email: "" }))}
                          className="absolute right-3 text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-200/50 transition-colors cursor-pointer"
                          title="Clear email"
                        >
                          <XMarkIcon className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    {newCustomer.email.trim().length > 0 && !isNewCustomerEmailValid && (
                      <p className="text-[11px] text-rose-500 font-medium">Enter a valid email address</p>
                    )}
                  </div>
                </div>

                {/* Inline banner when matching customer is detected */}
                {inlineMatchedCustomer && (
                  <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between gap-3 shadow-xs animate-fadeIn">
                    <div className="flex items-center gap-3 min-w-0">
                      <CustomerAvatar name={inlineMatchedCustomer.username} size="sm" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-200 text-amber-900 px-1.5 py-0.5 rounded">
                            Customer Already Exists
                          </span>
                        </div>
                        <p className="text-xs font-bold text-gray-900 truncate mt-0.5">
                          {inlineMatchedCustomer.username}
                        </p>
                        <p className="text-[11px] text-gray-600 truncate">
                          {inlineMatchedCustomer.phone ?? "No phone"} {inlineMatchedCustomer.email ? `· ${inlineMatchedCustomer.email}` : ""}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        selectCustomer(inlineMatchedCustomer);
                        setInlineMatchedCustomer(null);
                        toast.success(`Selected customer: ${inlineMatchedCustomer.username}`);
                      }}
                      className="shrink-0 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold shadow-xs transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <CheckIcon className="w-3.5 h-3.5" />
                      Use This Customer
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── STEP 2: Products ── */}
        {currentStep === "products" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Product picker */}
            <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
              <h2 className="text-lg font-bold text-gray-800">Add Products</h2>
              <div className="relative flex items-center bg-gray-50/60 hover:bg-gray-50/20 focus-within:bg-white border border-gray-200 hover:border-gray-300 focus-within:border-indigo-500 rounded-xl shadow-xs focus-within:shadow-md focus-within:ring-4 focus-within:ring-indigo-500/15 transition-all duration-200 group">
                <MagnifyingGlassIcon className="w-4 h-4 ml-3.5 text-gray-400 group-focus-within:text-indigo-600 transition-colors pointer-events-none shrink-0" />
                <input
                  type="text"
                  placeholder="Search products by title, SKU, or category…"
                  value={productSearch}
                  onChange={e => handleProductSearch(e.target.value)}
                  className="w-full pl-3 pr-9 h-11 text-sm font-medium text-gray-900 placeholder:text-gray-400 placeholder:font-normal bg-transparent focus:outline-none"
                />
                {productSearch && (
                  <button
                    type="button"
                    onClick={() => handleProductSearch("")}
                    className="absolute right-3 text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-200/50 transition-colors"
                    title="Clear search"
                  >
                    <XMarkIcon className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {productsLoading ? (
                <div className="flex justify-center py-12">
                  <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {products.map(p => {
                    const hasVariants = (p.variants?.length ?? 0) > 0;
                    const selectedVid = selectedVariantByProduct[p.id] ?? "";
                    const selectedVariant = hasVariants ? p.variants!.find(v => v.id === selectedVid) : undefined;
                    const inCart = hasVariants
                      ? (selectedVariant ? findCartLine(p.id, selectedVariant.id) : undefined)
                      : findCartLine(p.id, null);
                    const rowMaxStock = selectedVariant ? selectedVariant.stock : p.stock;
                    const displayImg = selectedVariant?.image || p.image;
                    const isRowClickable = !hasVariants && !inCart && p.stock > 0;

                    return (
                      <li
                        key={p.id}
                        onClick={() => {
                          if (isRowClickable) {
                            addToCart(p, null);
                          }
                        }}
                        className={`group flex items-center gap-3 py-3 px-3 rounded-xl transition-all duration-150 border ${
                          inCart
                            ? "bg-indigo-50/50 border-indigo-200/80 shadow-2xs"
                            : isRowClickable
                              ? "cursor-pointer hover:bg-slate-50 hover:border-slate-200 border-transparent"
                              : "border-transparent"
                        }`}
                      >
                        {displayImg ? (
                          <img src={displayImg} alt={p.name} className="w-12 h-12 rounded-lg object-cover shrink-0 border border-slate-100" />
                        ) : (
                          <div className="w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                            <ShoppingCartIcon className="w-5 h-5 text-gray-400" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold text-gray-800 truncate">{p.name}</p>
                            {inCart && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-700 shrink-0">
                                In Cart ({inCart.quantity})
                              </span>
                            )}
                          </div>
                          {p.description && stripHtml(p.description) && (
                            <p className="text-[11px] text-gray-500 line-clamp-1 mt-0.5" title={stripHtml(p.description)}>
                              {stripHtml(p.description)}
                            </p>
                          )}
                          {hasVariants ? (
                            <div className="mt-1" onClick={e => e.stopPropagation()}>
                              <ProductVariantDropdown
                                variants={p.variants!}
                                basePrice={p.price}
                                productDiscount={p.discount}
                                selectedVariantId={selectedVid}
                                onSelect={vid => {
                                  setSelectedVariantByProduct(prev => ({ ...prev, [p.id]: vid }));
                                  const existing = findCartLine(p.id, vid);
                                  if (!existing) {
                                    addToCart(p, vid);
                                  }
                                }}
                              />
                            </div>
                          ) : (
                            <p className="text-xs text-gray-500 mt-1 flex items-center gap-1.5 flex-wrap">
                              <span className="font-semibold text-gray-900">
                                {formatCurrency(getEffectiveProductPrice(p).sellingPrice)}
                              </span>
                              {getEffectiveProductPrice(p).discountPercent > 0 && (
                                <>
                                  <span className="line-through text-gray-400">
                                    {formatCurrency(getEffectiveProductPrice(p).basePrice)}
                                  </span>
                                  <span className="text-emerald-600 font-medium">
                                    ({getEffectiveProductPrice(p).discountPercent}% OFF)
                                  </span>
                                </>
                              )}
                              <span>· Stock: {p.stock}</span>
                              {p.stock <= 0 && <span className="text-rose-600 font-semibold ml-1.5">(Out of stock)</span>}
                            </p>
                          )}
                        </div>
                        {inCart ? (
                          <div className="flex items-center gap-1.5 shrink-0 bg-white px-2 py-1 rounded-xl border border-indigo-200 shadow-2xs" onClick={e => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => updateQty(p.id, inCart.variantId, inCart.quantity - 1, rowMaxStock)}
                              className="w-6 h-6 flex items-center justify-center rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:scale-105 active:scale-95 transition-all cursor-pointer"
                              title="Decrease quantity"
                            >
                              <MinusIcon className="w-3 h-3" />
                            </button>
                            <span className="w-6 text-center text-sm font-bold text-indigo-900">{inCart.quantity}</span>
                            <button
                              type="button"
                              onClick={() => updateQty(p.id, inCart.variantId, inCart.quantity + 1, rowMaxStock)}
                              disabled={inCart.quantity >= rowMaxStock}
                              className="w-6 h-6 flex items-center justify-center rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:scale-105 active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition-all cursor-pointer"
                              title="Increase quantity"
                            >
                              <PlusIcon className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : hasVariants ? null : p.stock > 0 ? (
                          <div className="shrink-0 flex items-center gap-1.5 text-xs font-semibold text-indigo-600 group-hover:text-indigo-700 bg-indigo-50/60 group-hover:bg-indigo-100 px-3 py-1.5 rounded-lg border border-indigo-100 transition-all pointer-events-none">
                            <PlusIcon className="w-3.5 h-3.5" />
                            <span>Select</span>
                          </div>
                        ) : (
                          <span className="text-xs font-medium text-slate-400 shrink-0">Out of Stock</span>
                        )}
                      </li>
                    );
                  })}
                  {products.length === 0 && !productsLoading && (
                    <li className="py-10 text-center text-gray-400 text-sm">No products found</li>
                  )}
                </ul>
              )}

              {/* Pagination */}
              {productTotalPages > 1 && (
                <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                  <button type="button" disabled={productPage <= 1} onClick={() => setProductPage(p => p - 1)}
                    className="flex items-center gap-1 text-xs text-gray-600 disabled:opacity-40 hover:text-indigo-600 transition-colors">
                    <ChevronLeftIcon className="w-4 h-4" /> Prev
                  </button>
                  <span className="text-xs text-gray-500">Page {productPage} / {productTotalPages}</span>
                  <button type="button" disabled={productPage >= productTotalPages} onClick={() => setProductPage(p => p + 1)}
                    className="flex items-center gap-1 text-xs text-gray-600 disabled:opacity-40 hover:text-indigo-600 transition-colors">
                    Next <ChevronRightIcon className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>

            {/* Cart summary */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4 h-fit">
              <h2 className="text-base font-bold text-gray-800">Cart ({cart.length})</h2>
              {cart.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">No items yet</p>
              ) : (
                <ul className="divide-y divide-gray-100 space-y-0">
                  {cart.map(item => (
                    <li key={`${item.product.id}-${item.variantId ?? "base"}`} className="flex items-center gap-2 py-2.5">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-gray-700 truncate">{item.product.name}</p>
                        {item.variantOptions && (
                          <p className="text-[11px] text-gray-400 truncate">
                            {Object.entries(item.variantOptions).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                          </p>
                        )}
                        <p className="text-xs text-gray-500 flex items-center gap-1 flex-wrap">
                          <span>{formatCurrency(item.unitPrice)}</span>
                          {item.basePrice != null && item.basePrice > item.unitPrice && (
                            <span className="line-through text-gray-400 text-[11px]">{formatCurrency(item.basePrice)}</span>
                          )}
                          <span>× {item.quantity}</span>
                        </p>
                      </div>
                      <p className="text-xs font-bold text-indigo-600 shrink-0">{formatCurrency(item.unitPrice * item.quantity)}</p>
                      <button type="button" onClick={() => removeFromCart(item.product.id, item.variantId)}
                        className="text-red-400 hover:text-red-600 transition-colors shrink-0">
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {cart.length > 0 && (
                <>
                  {/* Coupon */}
                  <div className="pt-3 border-t border-gray-100">
                    {appliedCoupon ? (
                      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-xl animate-fadeIn">
                        <div className="flex items-center gap-2 min-w-0">
                          <TicketIcon className="w-4 h-4 text-emerald-600 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-emerald-900 truncate">{appliedCoupon.code}</p>
                            <p className="text-[11px] text-emerald-600">
                              {appliedCoupon.discountType === "PERCENTAGE"
                                ? `${appliedCoupon.discountValue}% off`
                                : `QAR ${appliedCoupon.discountAmount.toLocaleString("en-QA")} off`}
                            </p>
                          </div>
                        </div>
                        <button type="button" onClick={handleRemoveCoupon}
                          className="shrink-0 text-emerald-700 hover:text-red-600 transition-colors">
                          <XMarkIcon className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <TicketIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                          <input
                            type="text"
                            placeholder="Coupon code"
                            value={couponCode}
                            onChange={e => setCouponCode(e.target.value.toUpperCase())}
                            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleApplyCoupon(); } }}
                            className="w-full pl-8 pr-2 py-2 text-xs font-semibold uppercase tracking-wide border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={handleApplyCoupon}
                          disabled={!couponCode.trim() || couponLoading}
                          className="shrink-0 px-3 py-2 text-xs font-bold text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {couponLoading ? "…" : "Apply"}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="pt-3 border-t border-gray-200 space-y-1.5">
                    {appliedCoupon && (
                      <>
                        <div className="flex justify-between text-xs text-gray-500">
                          <span>Subtotal</span>
                          <span>QAR {cartTotal.toLocaleString("en-QA")}</span>
                        </div>
                        <div className="flex justify-between text-xs text-emerald-600 font-semibold">
                          <span>Discount</span>
                          <span>−QAR {appliedCoupon.discountAmount.toLocaleString("en-QA")}</span>
                        </div>
                      </>
                    )}
                    <div className="flex justify-between text-sm font-bold text-gray-800">
                      <span>Total</span>
                      <span>QAR {orderTotal.toLocaleString("en-QA")}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── STEP 3: Address ── */}
        {currentStep === "address" && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sm:p-7 space-y-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-5 border-b border-gray-100">
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100 shadow-xs shrink-0">
                  <MapPinIcon className="w-6 h-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold text-gray-900">Delivery Address</h2>
                    <span className="text-[11px] font-semibold text-slate-500 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-full">
                      Optional
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">Enter shipping address for delivery, or leave blank for store / counter pickup</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
                {selectedCustomer?.recentAddress?.fullAddress && (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs font-semibold text-emerald-700 animate-fadeIn">
                    <CheckCircleSolid className="w-3.5 h-3.5 text-emerald-600" />
                    Auto-filled from previous order
                  </div>
                )}
                <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-gray-200/80 rounded-xl text-xs font-medium text-gray-600">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  Qatar Delivery
                </div>
              </div>
            </div>

            <div className="space-y-5">
              {/* Row 1: P.O. Box & Area */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
                {/* P.O. Box */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-xs font-bold text-gray-700 uppercase tracking-wider">
                      <HashtagIcon className="w-3.5 h-3.5 text-indigo-600" />
                      P.O. Box <span className="text-gray-400 font-normal lowercase tracking-normal">(optional)</span>
                    </label>
                  </div>
                  <div className="relative flex items-center bg-gray-50/60 hover:bg-gray-50/20 focus-within:bg-white border border-gray-200 hover:border-gray-300 focus-within:border-indigo-500 rounded-xl shadow-xs focus-within:shadow-md focus-within:ring-4 focus-within:ring-indigo-500/15 transition-all duration-200 group">
                    <HashtagIcon className="w-4 h-4 ml-3.5 text-gray-400 group-focus-within:text-indigo-600 transition-colors pointer-events-none shrink-0" />
                    <input
                      type="text"
                      placeholder="Enter P.O. Box"
                      maxLength={20}
                      value={address.zipCode}
                      onChange={e => handlePoBoxChange(e.target.value)}
                      className="w-full pl-3 pr-9 h-11 text-sm font-semibold tracking-wider text-gray-900 placeholder:text-gray-400 placeholder:font-normal placeholder:tracking-normal bg-transparent focus:outline-none"
                    />
                    {address.zipCode ? (
                      <button
                        type="button"
                        onClick={handleClearPoBox}
                        className="absolute right-3 text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-200/50 transition-colors cursor-pointer"
                        title="Clear P.O. Box"
                      >
                        <XMarkIcon className="w-3.5 h-3.5" />
                      </button>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-gray-400">
                    P.O. Box is optional; add your delivery area in the address fields.
                  </p>
                </div>

                {/* Area / Locality */}
                <div className="space-y-1.5" ref={localityDropdownRef}>
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-xs font-bold text-gray-700 uppercase tracking-wider">
                      <MapPinIcon className="w-3.5 h-3.5 text-indigo-600" />
                      Area / Locality <span className="text-gray-400 font-normal lowercase tracking-normal">(optional)</span>
                    </label>
                    {address.locality?.trim() ? (
                      <span className="text-[11px] font-semibold text-emerald-600 flex items-center gap-1 animate-fadeIn">
                        <CheckCircleSolid className="w-3.5 h-3.5" /> Selected
                      </span>
                    ) : availableLocalities.length > 1 ? (
                      <span className="text-[10px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-200/80 px-2 py-0.5 rounded-full animate-fadeIn">
                        {availableLocalities.length} under PIN
                      </span>
                    ) : null}
                  </div>
                  {availableLocalities.length > 0 ? (
                    <div className="relative">
                      {/* Trigger Button */}
                      <button
                        type="button"
                        onClick={() => {
                          setLocalityDropdownOpen(prev => !prev);
                          setLocalityFilter("");
                        }}
                        className={`w-full flex items-center justify-between px-3.5 h-11 rounded-xl border text-sm font-medium transition-all duration-200 text-left cursor-pointer ${
                          localityDropdownOpen
                            ? "border-indigo-500 bg-white ring-4 ring-indigo-500/15 shadow-md"
                            : "bg-gray-50/60 hover:bg-gray-50/20 hover:border-gray-300 border-gray-200 shadow-xs"
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <MapPinIcon
                            className={`w-4 h-4 shrink-0 transition-colors ${
                              localityDropdownOpen || address.locality ? "text-indigo-600" : "text-gray-400"
                            }`}
                          />
                          <span className={`truncate ${address.locality ? "text-gray-900 font-semibold" : "text-gray-400 font-normal"}`}>
                            {address.locality || "-- Select Area / Locality --"}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {address.locality && (
                            <span
                              role="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setAddress(p => ({ ...p, locality: "" }));
                              }}
                              className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
                              title="Clear post office"
                            >
                              <XMarkIcon className="w-3.5 h-3.5" />
                            </span>
                          )}
                          <ChevronDownIcon
                            className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${
                              localityDropdownOpen ? "rotate-180 text-indigo-600" : ""
                            }`}
                          />
                        </div>
                      </button>

                      {/* Dropdown Menu */}
                      {localityDropdownOpen && (
                        <div className="absolute left-0 right-0 z-30 mt-1.5 bg-white border border-gray-100 rounded-2xl shadow-xl shadow-indigo-950/10 p-2 animate-fadeIn">
                          {/* Search filter inside dropdown */}
                          <div className="relative mb-2">
                            <MagnifyingGlassIcon className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                            <input
                              type="text"
                              autoFocus
                              placeholder="Type to filter post office…"
                              value={localityFilter}
                              onChange={e => setLocalityFilter(e.target.value)}
                              className="w-full pl-8 pr-3 py-1.5 text-xs font-medium text-gray-800 bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all"
                            />
                          </div>

                          {/* Options List */}
                          <div className="max-h-56 overflow-y-auto space-y-0.5">
                            {availableLocalities
                              .filter(loc => loc.toLowerCase().includes(localityFilter.trim().toLowerCase()))
                              .map(loc => {
                                const isSelected = address.locality === loc;
                                return (
                                  <button
                                    key={loc}
                                    type="button"
                                    onClick={() => {
                                      setAddress(p => ({ ...p, locality: loc }));
                                      setLocalityDropdownOpen(false);
                                      setLocalityFilter("");
                                    }}
                                    className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-xl transition-colors text-left cursor-pointer ${
                                      isSelected
                                        ? "bg-indigo-50 text-indigo-700 font-bold"
                                        : "text-gray-700 hover:bg-gray-50 hover:text-indigo-600"
                                    }`}
                                  >
                                    <div className="flex items-center gap-2 truncate">
                                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isSelected ? "bg-indigo-600" : "bg-slate-300"}`} />
                                      <span className="truncate">{loc}</span>
                                    </div>
                                    {isSelected && <CheckIcon className="w-4 h-4 text-indigo-600 shrink-0" />}
                                  </button>
                                );
                              })}
                            {localityFilter.trim() && !availableLocalities.some(loc => loc.toLowerCase() === localityFilter.trim().toLowerCase()) && (
                              <div className="pt-1.5 border-t border-gray-100">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setAddress(p => ({ ...p, locality: localityFilter.trim() }));
                                    setLocalityDropdownOpen(false);
                                    setLocalityFilter("");
                                  }}
                                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 rounded-xl transition-colors text-left cursor-pointer"
                                >
                                  <span>Use custom:</span>
                                  <strong className="truncate font-bold">"{localityFilter.trim()}"</strong>
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="relative flex items-center bg-gray-50/60 hover:bg-gray-50/20 focus-within:bg-white border border-gray-200 hover:border-gray-300 focus-within:border-indigo-500 rounded-xl shadow-xs focus-within:shadow-md focus-within:ring-4 focus-within:ring-indigo-500/15 transition-all duration-200 group">
                      <MapPinIcon className="w-4 h-4 ml-3.5 text-gray-400 group-focus-within:text-indigo-600 transition-colors pointer-events-none shrink-0" />
                      <input
                        type="text"
                        placeholder="e.g. Jumeirah, Al Reem Island"
                        value={address.locality || ""}
                        onChange={e => setAddress(p => ({ ...p, locality: e.target.value }))}
                        className="w-full pl-3 pr-9 h-11 text-sm font-medium text-gray-900 placeholder:text-gray-400 placeholder:font-normal bg-transparent focus:outline-none"
                      />
                      {address.locality && (
                        <button
                          type="button"
                          onClick={() => setAddress(p => ({ ...p, locality: "" }))}
                          className="absolute right-3 text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-200/50 transition-colors cursor-pointer"
                          title="Clear area"
                        >
                          <XMarkIcon className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                  <p className="text-[11px] text-gray-400">
                    Enter the neighborhood or delivery area.
                  </p>
                </div>
              </div>

              {/* Row 2: City / District, State & Country */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-5">
                {/* City */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-xs font-bold text-gray-700 uppercase tracking-wider">
                      <BuildingOffice2Icon className="w-3.5 h-3.5 text-indigo-600" />
                      City <span className="text-gray-400 font-normal lowercase tracking-normal">(optional)</span>
                    </label>
                    {address.city.trim() && (
                      <span className="text-[11px] font-semibold text-emerald-600 flex items-center gap-1 animate-fadeIn">
                        <CheckCircleSolid className="w-3.5 h-3.5" /> Valid
                      </span>
                    )}
                  </div>
                  <div className="relative flex items-center bg-gray-50/60 hover:bg-gray-50/20 focus-within:bg-white border border-gray-200 hover:border-gray-300 focus-within:border-indigo-500 rounded-xl shadow-xs focus-within:shadow-md focus-within:ring-4 focus-within:ring-indigo-500/15 transition-all duration-200 group">
                    <BuildingOffice2Icon className="w-4 h-4 ml-3.5 text-gray-400 group-focus-within:text-indigo-600 transition-colors pointer-events-none shrink-0" />
                    <input
                      type="text"
                      placeholder="e.g. Dubai, Abu Dhabi, Sharjah"
                      value={address.city}
                      onChange={e => setAddress(p => ({ ...p, city: e.target.value }))}
                      className="w-full pl-3 pr-9 h-11 text-sm font-medium text-gray-900 placeholder:text-gray-400 placeholder:font-normal bg-transparent focus:outline-none"
                    />
                    {address.city && (
                      <button
                        type="button"
                        onClick={() => setAddress(p => ({ ...p, city: "" }))}
                        className="absolute right-3 text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-200/50 transition-colors cursor-pointer"
                        title="Clear city"
                      >
                        <XMarkIcon className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* State */}
                <div className="space-y-1.5" ref={stateDropdownRef}>
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-xs font-bold text-gray-700 uppercase tracking-wider">
                      <MapIcon className="w-3.5 h-3.5 text-indigo-600" />
                      Municipality <span className="text-gray-400 font-normal lowercase tracking-normal">(optional)</span>
                    </label>
                    {address.state.trim() && (
                      <span className="text-[11px] font-semibold text-emerald-600 flex items-center gap-1 animate-fadeIn">
                        <CheckCircleSolid className="w-3.5 h-3.5" /> Valid
                      </span>
                    )}
                  </div>
                  <div className="relative">
                    {/* Trigger Button */}
                    <button
                      type="button"
                      onClick={() => {
                        setStateDropdownOpen(prev => !prev);
                        setStateFilter("");
                      }}
                      className={`w-full flex items-center justify-between px-3.5 h-11 rounded-xl border text-sm font-medium transition-all duration-200 text-left cursor-pointer ${
                        stateDropdownOpen
                          ? "border-indigo-500 bg-white ring-4 ring-indigo-500/15 shadow-md"
                          : "bg-gray-50/60 hover:bg-gray-50/20 hover:border-gray-300 border-gray-200 shadow-xs"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <MapIcon
                          className={`w-4 h-4 shrink-0 transition-colors ${
                            stateDropdownOpen || address.state ? "text-indigo-600" : "text-gray-400"
                          }`}
                        />
                        <span className={`truncate ${address.state ? "text-gray-900 font-semibold" : "text-gray-400 font-normal"}`}>
                          {address.state || "Select Municipality"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {address.state && (
                          <span
                            role="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAddress(p => ({ ...p, state: "" }));
                            }}
                            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
                            title="Clear state"
                          >
                            <XMarkIcon className="w-3.5 h-3.5" />
                          </span>
                        )}
                        <ChevronDownIcon
                          className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${
                            stateDropdownOpen ? "rotate-180 text-indigo-600" : ""
                          }`}
                        />
                      </div>
                    </button>

                    {/* Matching Custom Dropdown Menu */}
                    {stateDropdownOpen && (
                      <div className="absolute left-0 right-0 z-30 mt-1.5 bg-white border border-gray-100 rounded-2xl shadow-xl shadow-indigo-950/10 p-2 animate-fadeIn">
                        {/* Search filter inside dropdown */}
                        <div className="relative mb-2">
                          <MagnifyingGlassIcon className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                          <input
                            type="text"
                            autoFocus
                            placeholder="Type to search municipality…"
                            value={stateFilter}
                            onChange={e => setStateFilter(e.target.value)}
                            className="w-full pl-8 pr-3 py-1.5 text-xs font-medium text-gray-800 bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all"
                          />
                        </div>

                        {/* Options List */}
                        <div className="max-h-56 overflow-y-auto space-y-0.5">
                          {QATAR_MUNICIPALITIES.filter(st =>
                            st.toLowerCase().includes(stateFilter.trim().toLowerCase())
                          ).map(st => {
                            const isSelected = address.state === st;
                            return (
                              <button
                                key={st}
                                type="button"
                                onClick={() => {
                                  setAddress(p => ({ ...p, state: st }));
                                  setStateDropdownOpen(false);
                                  setStateFilter("");
                                }}
                                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-xl transition-colors text-left cursor-pointer ${
                                  isSelected
                                    ? "bg-indigo-50 text-indigo-700 font-bold"
                                    : "text-gray-700 hover:bg-gray-50 hover:text-indigo-600"
                                }`}
                              >
                                <span>{st}</span>
                                {isSelected && <CheckIcon className="w-4 h-4 text-indigo-600 shrink-0" />}
                              </button>
                            );
                          })}
                          {QATAR_MUNICIPALITIES.filter(mun =>
                            mun.toLowerCase().includes(stateFilter.trim().toLowerCase())
                          ).length === 0 && (
                            <p className="py-4 text-center text-xs text-gray-400">No matching municipality</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Country */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-1.5 text-xs font-bold text-gray-700 uppercase tracking-wider">
                      <GlobeAmericasIcon className="w-3.5 h-3.5 text-indigo-600" />
                      Country <span className="text-gray-400 font-normal lowercase tracking-normal">(optional)</span>
                    </label>
                    <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-gray-100 px-2 py-0.5 rounded-full border border-gray-200/60">
                      Qatar
                    </span>
                  </div>
                  <div className="relative flex items-center bg-gray-50/60 hover:bg-gray-50/20 focus-within:bg-white border border-gray-200 hover:border-gray-300 focus-within:border-indigo-500 rounded-xl shadow-xs focus-within:shadow-md focus-within:ring-4 focus-within:ring-indigo-500/15 transition-all duration-200 group">
                    <span className="ml-3.5 text-base leading-none select-none pointer-events-none">🇶🇦</span>
                    <input
                      type="text"
                      value="Qatar"
                      readOnly
                      className="w-full pl-3 pr-9 h-11 text-sm font-medium text-gray-900 bg-transparent focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Full Address */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1.5 text-xs font-bold text-gray-700 uppercase tracking-wider">
                    <HomeIcon className="w-3.5 h-3.5 text-indigo-600" />
                    Full Address <span className="text-gray-400 font-normal lowercase tracking-normal">(optional)</span>
                  </label>
                  {address.fullAddress.trim() && (
                    <span className="text-[11px] font-semibold text-emerald-600 flex items-center gap-1 animate-fadeIn">
                      <CheckCircleSolid className="w-3.5 h-3.5" /> Filled
                    </span>
                  )}
                </div>
                <div className="relative flex bg-gray-50/60 hover:bg-gray-50/20 focus-within:bg-white border border-gray-200 hover:border-gray-300 focus-within:border-indigo-500 rounded-xl shadow-xs focus-within:shadow-md focus-within:ring-4 focus-within:ring-indigo-500/15 transition-all duration-200 group">
                  <div className="pl-3.5 pt-3 pointer-events-none text-gray-400 group-focus-within:text-indigo-600 transition-colors">
                    <HomeIcon className="w-4 h-4" />
                  </div>
                  <textarea
                    rows={2}
                    placeholder="House / Flat no., Building name, Street, Locality, Landmark…"
                    value={address.fullAddress}
                    onChange={e => setAddress(p => ({ ...p, fullAddress: e.target.value }))}
                    className="w-full pl-3 pr-9 py-2.5 text-sm font-medium text-gray-900 placeholder:text-gray-400 placeholder:font-normal bg-transparent focus:outline-none resize-none leading-relaxed"
                  />
                  {address.fullAddress && (
                    <button
                      type="button"
                      onClick={() => setAddress(p => ({ ...p, fullAddress: "" }))}
                      className="absolute right-3 top-3 text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-200/50 transition-colors"
                      title="Clear address"
                    >
                      <XMarkIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-gray-400">Include door number, street, and nearby landmark for seamless delivery.</p>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 4: Payment ── */}
        {currentStep === "payment" && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-6">
            <h2 className="text-lg font-bold text-gray-800">Payment Details</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => setPaymentMethod("POD")}
                className={`flex flex-col items-center gap-2 p-5 rounded-xl border-2 transition-colors
                  ${paymentMethod === "POD" ? "border-indigo-600 bg-indigo-50" : "border-gray-200 hover:border-indigo-300 bg-white"}`}
              >
                <MapPinIcon className={`w-8 h-8 ${paymentMethod === "POD" ? "text-indigo-600" : "text-gray-400"}`} />
                <span className={`font-bold text-sm ${paymentMethod === "POD" ? "text-indigo-700" : "text-gray-600"}`}>Pay on Delivery</span>
                <span className="text-xs text-gray-500 text-center">Payment will be collected at delivery</span>
              </button>
              <button
                type="button"
                onClick={() => setPaymentMethod("CASH")}
                className={`flex flex-col items-center gap-2 p-5 rounded-xl border-2 transition-colors
                  ${paymentMethod === "CASH" ? "border-indigo-600 bg-indigo-50" : "border-gray-200 hover:border-indigo-300 bg-white"}`}
              >
                <CreditCardIcon className={`w-8 h-8 ${paymentMethod === "CASH" ? "text-indigo-600" : "text-gray-400"}`} />
                <span className={`font-bold text-sm ${paymentMethod === "CASH" ? "text-indigo-700" : "text-gray-600"}`}>Cash Collected</span>
                <span className="text-xs text-gray-500 text-center">Customer paid in cash at the counter</span>
              </button>
            </div>

            <div>
              <label className="flex items-center gap-1.5 text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">
                <DocumentTextIcon className="w-3.5 h-3.5 text-indigo-600" />
                Payment Note <span className="text-gray-400 font-normal lowercase tracking-normal">(receipt no, UPI ref, etc.)</span>
              </label>
              <div className="relative flex items-center bg-gray-50/60 hover:bg-gray-50/20 focus-within:bg-white border border-gray-200 hover:border-gray-300 focus-within:border-indigo-500 rounded-xl shadow-xs focus-within:shadow-md focus-within:ring-4 focus-within:ring-indigo-500/15 transition-all duration-200 group max-w-xl">
                <DocumentTextIcon className="w-4 h-4 ml-3.5 text-gray-400 group-focus-within:text-indigo-600 transition-colors pointer-events-none shrink-0" />
                <input
                  type="text"
                  placeholder="e.g. Receipt #1234, UPI ref: abc123xyz"
                  value={paymentNote}
                  onChange={e => setPaymentNote(e.target.value)}
                  className="w-full pl-3 pr-9 h-11 text-sm font-medium text-gray-900 placeholder:text-gray-400 placeholder:font-normal bg-transparent focus:outline-none"
                />
                {paymentNote && (
                  <button
                    type="button"
                    onClick={() => setPaymentNote("")}
                    className="absolute right-3 text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-200/50 transition-colors"
                    title="Clear note"
                  >
                    <XMarkIcon className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 5: Confirm ── */}
        {currentStep === "confirm" && (
          <div className="space-y-4">
            {recentOrderWarning && (
              <div className="bg-amber-50/90 border border-amber-300 rounded-2xl p-4 sm:p-5 flex items-start justify-between gap-4 shadow-sm animate-fadeIn">
                <div className="flex items-start gap-3.5">
                  <div className="w-10 h-10 rounded-xl bg-amber-500 text-white flex items-center justify-center shrink-0 shadow-md shadow-amber-500/20">
                    <ClockIcon className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-sm font-bold text-amber-950">
                        Notice: Previous Order Placed in Last 24 Hours
                      </h4>
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-200 text-amber-900 font-mono">
                        {recentOrderWarning.relativeTime}
                      </span>
                    </div>
                    <p className="text-xs text-amber-800 mt-1 leading-relaxed">
                      This customer placed an order on{" "}
                      <strong className="text-amber-950 underline decoration-amber-400">
                        {recentOrderWarning.formattedTime}
                      </strong>{" "}
                      ({recentOrderWarning.relativeTime}) for {formatCurrency(recentOrderWarning.finalAmount, recentOrderWarning.currency)}.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setRecentOrderModalOpen(true)}
                  className="shrink-0 px-3 py-1.5 bg-white hover:bg-amber-100 text-amber-900 border border-amber-300 rounded-xl text-xs font-bold transition shadow-2xs cursor-pointer"
                >
                  View Details
                </button>
              </div>
            )}

            {/* Customer summary */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-bold text-gray-700 mb-3 uppercase tracking-wide">Customer</h3>
              {selectedCustomer ? (
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-gray-800">{selectedCustomer.username}</p>
                    {selectedCustomer.emailVerifiedAt && !selectedCustomer.posActivationRequired ? (
                      <span className="text-[10px] font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                        Email Verified
                      </span>
                    ) : selectedCustomer.email ? (
                      <span className="text-[10px] font-bold bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
                        Pending Online Activation
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm text-gray-500">{selectedCustomer.phone ?? "—"} · {selectedCustomer.email ?? "No email"}</p>
                </div>
              ) : (
                <div>
                  <p className="font-semibold text-gray-800">
                    {newCustomer.username}{" "}
                    <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">New</span>
                    <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-bold">
                      Counter Verification Optional After Order
                    </span>
                  </p>
                  <p className="text-sm text-gray-500">{newCustomer.phone} {newCustomer.email ? `· ${newCustomer.email}` : ""}</p>
                </div>
              )}
            </div>

            {/* Items summary */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-bold text-gray-700 mb-3 uppercase tracking-wide">Items ({cart.length})</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 border-b border-gray-100">
                    <th className="pb-2 text-left font-semibold">Product</th>
                    <th className="pb-2 text-center font-semibold">Qty</th>
                    <th className="pb-2 text-right font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {cart.map(item => (
                    <tr key={`${item.product.id}-${item.variantId ?? "base"}`}>
                      <td className="py-2 text-gray-700">
                        {item.product.name}
                        {item.variantOptions && (
                          <span className="block text-xs text-gray-400">
                            {Object.entries(item.variantOptions).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-center text-gray-600">{item.quantity}</td>
                      <td className="py-2 text-right font-semibold text-gray-800">
                        <div>{formatCurrency(item.unitPrice * item.quantity)}</div>
                        {item.basePrice != null && item.basePrice > item.unitPrice && (
                          <div className="text-xs font-normal line-through text-gray-400">
                            {formatCurrency(item.basePrice * item.quantity)}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {appliedCoupon && (
                    <>
                      <tr>
                        <td colSpan={2} className="pt-3 text-gray-500">Subtotal</td>
                        <td className="pt-3 text-right text-gray-600">{formatCurrency(cartTotal)}</td>
                      </tr>
                      <tr>
                        <td colSpan={2} className="text-emerald-600 font-semibold flex items-center gap-1.5 pt-1">
                          <TicketIcon className="w-3.5 h-3.5" /> {appliedCoupon.code}
                        </td>
                        <td className="text-right text-emerald-600 font-semibold pt-1">−{formatCurrency(appliedCoupon.discountAmount)}</td>
                      </tr>
                    </>
                  )}
                  <tr className="border-t border-gray-200">
                    <td colSpan={2} className="pt-3 font-bold text-gray-800">Total</td>
                    <td className="pt-3 text-right font-bold text-indigo-700 text-base">QAR {orderTotal.toLocaleString("en-QA")}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Address summary */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide">Delivery Address</h3>
                {!(address.fullAddress.trim() || address.locality?.trim() || address.city.trim() || address.state.trim() || address.zipCode.trim()) && (
                  <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-0.5 rounded-full font-medium">
                    Store / Counter Pickup
                  </span>
                )}
              </div>
              {address.fullAddress.trim() || address.locality?.trim() || address.city.trim() || address.state.trim() || address.zipCode.trim() ? (
                <div>
                  {address.fullAddress.trim() && <p className="text-sm font-medium text-gray-800">{address.fullAddress}</p>}
                  <p className="text-sm text-gray-500">
                    {[address.locality ? `PO: ${address.locality}` : "", address.city, address.state].filter(Boolean).join(", ")}
                    {address.zipCode ? ` ${address.zipCode}` : ""}
                    {address.country ? `, ${address.country}` : ""}
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2.5 text-sm text-gray-500 py-1">
                  <BuildingStorefrontIcon className="w-4 h-4 text-gray-400 shrink-0" />
                  <span>No delivery address specified (Handled as Store / Counter Pickup)</span>
                </div>
              )}
            </div>

            {/* Payment summary */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
              <h3 className="text-sm font-bold text-gray-700 mb-3 uppercase tracking-wide">Payment</h3>
              <div className="flex items-center gap-3">
                <span className={`inline-block px-3 py-1 rounded-full text-xs font-bold ${paymentMethod === "CASH" ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"}`}>
                  {paymentMethod === "CASH" ? "Cash Collected" : "Pay on Delivery"}
                </span>
                {paymentNote && <span className="text-sm text-gray-500">Ref: {paymentNote}</span>}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Sticky Bottom Navigation Bar ── */}
      <div className="sticky bottom-0 z-30 bg-white/95 backdrop-blur-md border-t border-gray-200 px-4 sm:px-8 py-3.5 shadow-[0_-4px_16px_rgba(0,0,0,0.04)] shrink-0">
        <div className="w-full flex items-center justify-between">
          <button
            type="button"
            onClick={goBack}
            disabled={stepIndex === 0}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-gray-700 bg-white border border-gray-300 rounded-xl hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <ChevronLeftIcon className="w-4 h-4" /> Back
          </button>

          {currentStep !== "confirm" ? (
            <button
              type="button"
              onClick={goNext}
              disabled={!canProceed()}
              className="flex items-center gap-2 px-6 py-2.5 text-sm font-semibold text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              Next <ChevronRightIcon className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handlePlaceOrder(false)}
              disabled={placing || recentOrderChecking}
              className="flex items-center gap-2 px-7 py-2.5 text-sm font-bold text-white bg-green-600 rounded-xl hover:bg-green-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              {placing || recentOrderChecking ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  {recentOrderChecking ? "Checking…" : "Placing…"}
                </>
              ) : (
                <>
                  <CheckCircleIcon className="w-4 h-4" /> Place Order
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* ── Duplicate Customer Conflict Modal ── */}
      {conflictModalOpen && conflictCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50 px-4 backdrop-blur-sm animate-fadeIn">
          <div className="bg-white rounded-2xl shadow-2xl shadow-gray-900/20 max-w-lg w-full overflow-hidden border border-gray-100 flex flex-col animate-scaleUp">
            {/* Modal Header */}
            <div className="flex items-start justify-between px-6 pt-6 pb-5 bg-gradient-to-br from-indigo-50/80 via-white to-white border-b border-gray-100 shrink-0">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 to-indigo-700 text-white shadow-lg shadow-indigo-500/25">
                  <UserCircleIcon className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="text-lg font-black text-gray-950 tracking-tight">Customer Already Exists</h2>
                  <span className="inline-block mt-0.5 text-[11px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-100/80 px-2 py-0.5 rounded-full">
                    Existing Customer Found
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setConflictModalOpen(false)}
                className="text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg p-1.5 transition"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-gray-600 leading-relaxed">
                {conflictReason || "A customer with this phone number or email is already registered."}{" "}
                {conflictTriggerSource === "step1_next" || currentStep === "customer"
                  ? "Would you like to select this existing customer and continue to product selection?"
                  : "Would you like to select this customer to complete and place the order immediately?"}
              </p>

              {/* Matched Customer Profile Card */}
              <div className="rounded-2xl border border-gray-100 bg-gray-50/80 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold tracking-wider uppercase text-indigo-700 bg-indigo-50 border border-indigo-100/80 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                    <SparklesIcon className="w-3 h-3 text-indigo-600" />
                    Matched Customer Account
                  </span>
                  <span className="text-xs font-semibold text-gray-400 font-mono">ID: #{conflictCustomer.id.slice(-6)}</span>
                </div>

                <div className="flex items-center gap-3.5 pt-0.5">
                  <CustomerAvatar name={conflictCustomer.username} size="md" />
                  <div className="min-w-0 flex-1">
                    <h4 className="text-base font-bold text-gray-900 truncate">
                      {conflictCustomer.username}
                    </h4>
                    {newCustomer.username.trim() && newCustomer.username.trim().toLowerCase() !== conflictCustomer.username.toLowerCase() && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        Entered name: <span className="font-medium text-gray-600">"{newCustomer.username}"</span>
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600 mt-1">
                      <span className="flex items-center gap-1">
                        <PhoneIcon className="w-3.5 h-3.5 text-gray-400" />
                        {conflictCustomer.phone ?? "No phone"}
                      </span>
                      {conflictCustomer.email && (
                        <span className="flex items-center gap-1">
                          <EnvelopeIcon className="w-3.5 h-3.5 text-gray-400" />
                          {conflictCustomer.email}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setConflictModalOpen(false);
                    setCurrentStep("customer");
                  }}
                  disabled={conflictSubmitting}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-gray-300 text-gray-700 font-semibold text-sm hover:bg-gray-50 transition text-center disabled:opacity-50"
                >
                  Edit Customer Details
                </button>
                <button
                  type="button"
                  onClick={handleSelectConflictCustomerAction}
                  disabled={conflictSubmitting}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm shadow-md shadow-indigo-600/20 transition disabled:opacity-60"
                >
                  {conflictSubmitting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Placing Order…
                    </>
                  ) : conflictTriggerSource === "step1_next" || currentStep === "customer" ? (
                    <>
                      Select & Continue <ArrowRightIcon className="w-4 h-4" />
                    </>
                  ) : (
                    <>
                      <CheckCircleIcon className="w-4 h-4" />
                      Select & Place Order
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── 24-Hour Recent Order Warning Modal ── */}
      {recentOrderModalOpen && recentOrderWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/60 px-4 backdrop-blur-sm animate-fadeIn">
          <div className="bg-white rounded-2xl shadow-2xl shadow-gray-900/30 max-w-lg w-full overflow-hidden border border-amber-200/90 flex flex-col animate-scaleUp">
            {/* Modal Header */}
            <div className="flex items-start justify-between px-6 pt-6 pb-5 bg-gradient-to-br from-amber-50 via-amber-50/40 to-white border-b border-amber-100 shrink-0">
              <div className="flex items-center gap-3">
                
                <div>
                  <h2 className="text-lg font-black text-gray-950 tracking-tight">Recent Order Detected</h2>
                  <span className="inline-block mt-0.5 text-[11px] font-bold text-amber-800 bg-amber-100 border border-amber-200 px-2.5 py-0.5 rounded-full">
                    Placed within last 24 hours
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRecentOrderModalOpen(false)}
                className="text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg p-1.5 transition cursor-pointer"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="px-6 py-5 space-y-4">
              <div className="p-3.5 bg-amber-50/90 border border-amber-200 rounded-xl">
                <p className="text-sm font-semibold text-amber-950 leading-relaxed">
                  ⚠️ This customer has already placed an order in the last 24 hours.
                </p>
                <p className="text-xs text-amber-800 mt-1">
                  Please verify the previous order placement time and order summary below before proceeding to avoid unintentional duplicate orders.
                </p>
              </div>

              {/* Order Highlight Card */}
              <div className="rounded-2xl border border-gray-200 bg-gray-50/80 p-4 space-y-3 shadow-2xs">
                {/* Header row */}
                <div className="flex items-center justify-between border-b border-gray-200/80 pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-gray-700">Previous Order</span>
                    <span className="font-mono text-xs font-bold text-indigo-600 bg-indigo-50 border border-indigo-200/60 px-2 py-0.5 rounded-md">
                      #{recentOrderWarning.shortId}
                    </span>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                    recentOrderWarning.orderStatus === "DELIVERED"
                      ? "bg-green-100 text-green-800"
                      : recentOrderWarning.orderStatus === "SHIPPED"
                      ? "bg-blue-100 text-blue-800"
                      : "bg-amber-100 text-amber-800"
                  }`}>
                    {recentOrderWarning.orderStatus}
                  </span>
                </div>

                {/* Key detail: Explicit Order Placement Time */}
                <div className="bg-white rounded-xl border border-amber-200/90 p-3 shadow-2xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-amber-800 flex items-center gap-1.5">
                      <ClockIcon className="w-3.5 h-3.5 text-amber-600" />
                      Order Placement Time
                    </span>
                    <span className="text-xs font-extrabold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-md">
                      {recentOrderWarning.relativeTime}
                    </span>
                  </div>
                  <p className="text-base font-extrabold text-gray-900 tracking-tight">
                    {recentOrderWarning.formattedTime}
                  </p>
                </div>

                {/* Customer & Amount details */}
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="bg-white rounded-xl border border-gray-200/70 p-2.5">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 block mb-0.5">
                      Customer
                    </span>
                    <p className="text-xs font-bold text-gray-800 truncate">
                      {recentOrderWarning.customerName || selectedCustomer?.username || newCustomer.username || "Customer"}
                    </p>
                  </div>

                  <div className="bg-white rounded-xl border border-gray-200/70 p-2.5">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 block mb-0.5">
                      Order Amount
                    </span>
                    <p className="text-xs font-extrabold text-gray-900">
                      {formatCurrency(recentOrderWarning.finalAmount, recentOrderWarning.currency)}
                    </p>
                  </div>
                </div>

                {/* Items Summary */}
                {recentOrderWarning.itemsSummary && (
                  <div className="bg-white rounded-xl border border-gray-200/70 p-2.5">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 block mb-1">
                      Items Ordered ({recentOrderWarning.itemsCount})
                    </span>
                    <p className="text-xs text-gray-700 font-medium line-clamp-2">
                      {recentOrderWarning.itemsSummary}
                    </p>
                  </div>
                )}

                {/* Channel & Invoice link */}
                <div className="flex items-center justify-between text-xs text-gray-500 pt-1">
                  <span>
                    Channel:{" "}
                    <strong className="text-gray-700">
                      {recentOrderWarning.placedByAdmin ? "Admin (Counter Sale)" : "Online Store"}
                    </strong>
                  </span>
                  <a
                    href={`/invoice/${recentOrderWarning.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-semibold"
                  >
                    <DocumentTextIcon className="w-3.5 h-3.5" /> View Invoice
                  </a>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setRecentOrderModalOpen(false)}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-gray-300 text-gray-700 font-semibold text-sm hover:bg-gray-50 transition text-center cursor-pointer"
                >
                  Cancel / Review
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRecentOrderModalOpen(false);
                    setBypassRecentOrder(true);
                    handlePlaceOrder(true);
                  }}
                  disabled={placing}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-sm shadow-md shadow-amber-600/25 transition disabled:opacity-60 cursor-pointer"
                >
                  {placing ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Placing…
                    </>
                  ) : (
                    <>
                      <CheckCircleIcon className="w-4 h-4" />
                      Place Order Anyway
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
