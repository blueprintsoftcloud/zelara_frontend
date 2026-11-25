import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  MapPinIcon,
  HomeIcon,
  PencilSquareIcon,
  TruckIcon,
  XMarkIcon,
  ChevronLeftIcon,
  CheckCircleIcon,
  ArrowRightIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";
import { BeatLoader } from "react-spinners";
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import toast from "react-hot-toast";
import api from "../utils/api";
import { useCart } from "../context/CartContext";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock";

const customIcon = new L.Icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

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

const QATAR_BOUNDS: [[number, number], [number, number]] = [
  [24.4, 50.6],
  [26.4, 51.8],
];

/** Invisible component that listens for map clicks — lets the preview-phase map
 * re-point the pin instead of only being a static confirmation image. */
function MapClickHandler({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/** MapContainer only honors `center` on initial mount — this keeps the view following
 * `position` if it ever changes from something other than a click on the map itself. */
function MapRecenter({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, map.getZoom());
  }, [center, map]);
  return null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface SavedAddress {
  id: string;
  fullAddress: string;
  city: string;
  state: string;
  zipCode: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
}

interface ShippingPreview {
  shippingCharge: number;
  distanceKm: number;
  type: "other_state" | "same_state_gps" | "manual" | "free";
  label: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  lat?: number;
  lng?: number;
  free?: boolean;
}

export interface DeliveryLocationModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Omit for the cart-checkout flow (Cartpage.tsx's "Continue to checkout") — this
   * modal then previews shipping for the whole cart instead of a single product, and
   * skips the "add to cart" step in handleProceed since everything's already there.
   * Set for the "Buy Now" flow (ProductDetailPage.tsx), where the product may not be
   * in the cart yet. */
  product?: { id: string; name: string; price: number; quantity?: number; variantId?: string | null };
}

type Phase = "select" | "manual_form" | "preview";
type LocMode = "map" | "saved" | "manual";

// ── Component ─────────────────────────────────────────────────────────────────

export default function DeliveryLocationModal({ isOpen, onClose, product }: DeliveryLocationModalProps) {
  const navigate = useNavigate();
  const { cartItems, addToCart, cartTotal } = useCart();
  useBodyScrollLock(isOpen);

  // Cart-checkout mode (no `product`): preview against every cart line instead of one
  // item. Buy Now mode: just the one product, same as before this generalized.
  const orderLines = product
    ? [{ name: product.name, price: product.price, quantity: product.quantity ?? 1 }]
    : cartItems.map((i) => ({ name: i.name, price: i.price, quantity: i.quantity }));
  const orderSubtotal = product ? product.price * (product.quantity ?? 1) : parseFloat(cartTotal) || 0;

  const [phase, setPhase] = useState<Phase>("select");
  const [locMode, setLocMode] = useState<LocMode | null>(null);
  const [savedAddress, setSavedAddress] = useState<SavedAddress | null>(null);
  const [addressLoading, setAddressLoading] = useState(false);
  const [position, setPosition] = useState<[number, number] | null>(null);
  const [preview, setPreview] = useState<ShippingPreview | null>(null);
  const [manualForm, setManualForm] = useState({ fullAddress: "", city: "", state: "", zipCode: "", locality: "" });
  const [addressError, setAddressError] = useState<string | null>(null);
  const addressInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [calcLoading, setCalcLoading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [repositioning, setRepositioning] = useState(false);

  // Reset + fetch saved address when modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      setPhase("select");
      setLocMode(null);
      setPosition(null);
      setPreview(null);
      setCalcLoading(false);
      setIsProcessing(false);
      setRepositioning(false);
      setAddressLoading(false);
      setManualForm({ fullAddress: "", city: "", state: "", zipCode: "", locality: "" });
      setAddressError(null);
      return;
    }
    setAddressLoading(true);
    api.get("/address/default")
      .then((res) => setSavedAddress(res.data.address))
      .catch(() => setSavedAddress(null))
      .finally(() => setAddressLoading(false));
  }, [isOpen]);

const isWithinQatarBoundingBox = (lat: number, lng: number): boolean => {
  return lat >= 24.4 && lat <= 26.4 && lng >= 50.6 && lng <= 51.8;
};

  // ── Location handlers ──────────────────────────────────────────────────────

  const handleSelectSaved = async () => {
    if (!savedAddress) return;
    const country = savedAddress.country?.trim().toLowerCase();
    if (country !== "qatar" && country !== "united arab emirates") {
      toast.error("This saved address is outside Qatar. Add a Qatar delivery address instead.");
      return;
    }
    setLocMode("saved");
    setCalcLoading(true);
    try {
      let res;
      if (savedAddress.latitude && savedAddress.longitude) {
        res = await api.post("/address/preview-shipping", {
          latitude: savedAddress.latitude,
          longitude: savedAddress.longitude,
        });
        setPosition([savedAddress.latitude, savedAddress.longitude]);
      } else {
        res = await api.post("/address/preview-shipping", {
          manual: true,
          state: savedAddress.state,
          city: savedAddress.city,
        });
        setPosition(null);
      }
      setPreview(res.data);
      setPhase("preview");
    } catch {
      toast.error("Failed to calculate shipping for your saved address");
      setLocMode(null);
    }
    setCalcLoading(false);
  };

  const handlePoBoxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setManualForm((prev) => ({ ...prev, zipCode: e.target.value.slice(0, 20) }));
  };

  const handleManualCalculate = async () => {
    const fullAddr = manualForm.fullAddress.trim();
    if (!fullAddr) {
      setAddressError("Please enter your House / Flat No., Street Name, or Area");
      addressInputRef.current?.focus();
      toast.error("Please enter your Full Address before calculating rates", { id: "manual-address" });
      return;
    }
    if (fullAddr.length < 5) {
      setAddressError("Please enter a complete address (minimum 5 characters)");
      addressInputRef.current?.focus();
      toast.error("Please enter a complete delivery address", { id: "manual-address" });
      return;
    }
    setAddressError(null);
    const state = manualForm.state.trim();
    if (!state) {
      toast.error("Please select your municipality", { id: "manual-state" });
      return;
    }
    if (!manualForm.city.trim()) {
      toast.error("Please enter your city", { id: "manual-city" });
      return;
    }
    setCalcLoading(true);
    try {
      const res = await api.post("/address/preview-shipping", { manual: true, state, city: manualForm.city.trim() });
      setPreview(res.data);
      setPhase("preview");
    } catch {
      toast.error("Failed to calculate shipping");
    }
    setCalcLoading(false);
  };

  // ── Re-point the pin from the preview map ────────────────────────────────
  // Lets the user correct GPS/saved-address drift by tapping a new spot instead of
  // starting the whole flow over — recalculates shipping for wherever
  // they clicked, same as a fresh GPS detection would.
  const handleRepositionPin = async (lat: number, lng: number) => {
    if (!isWithinQatarBoundingBox(lat, lng)) {
      toast.error("Please select a delivery location inside Qatar.");
      return;
    }
    setRepositioning(true);
    try {
      const res = await api.post("/address/preview-shipping", { latitude: lat, longitude: lng });
      setPreview({ ...res.data, lat, lng });
      setPosition([lat, lng]);
      setLocMode("map");
    } catch (err: any) {
      const msg = err.response?.data?.message || "Failed to recalculate shipping for that spot";
      toast.error(msg);
    } finally {
      setRepositioning(false);
    }
  };

  // ── Proceed to checkout ───────────────────────────────────────────────────

  const handleProceed = async () => {
    if (!preview) return;
    setIsProcessing(true);
    try {
      if (product) {
        const isInCart = cartItems.some(
          (i) => String(i.productId) === String(product.id) && String(i.variantId ?? "") === String(product.variantId ?? ""),
        );
        if (!isInCart) {
          await addToCart(product.id, { quantity: product.quantity ?? 1, variantId: product.variantId ?? null });
        }
      }

      if (locMode === "map" && position) {
        await api.post("/address/save-geo", { latitude: position[0], longitude: position[1] });
      } else if (locMode === "manual") {
        const addr = manualForm;
        const finalFull = addr.fullAddress
          ? (addr.locality && !addr.fullAddress.toLowerCase().includes(addr.locality.toLowerCase())
              ? `${addr.fullAddress}, ${addr.locality}`
              : addr.fullAddress)
          : (addr.locality ? `${addr.locality}, ${addr.city}` : `${addr.city}, ${addr.state}`);

        await api.post("/address/save-manual", {
          fullAddress: finalFull,
          city: addr.city || addr.state,
          state: addr.state,
          zipCode: addr.zipCode || "",
          locality: addr.locality || undefined,
        });
      }

      const addressPrefill = {
        fullAddress: locMode === "map"
          ? ""
          : locMode === "saved"
            ? (savedAddress?.fullAddress || `${savedAddress?.city}, ${savedAddress?.state}`)
            : (manualForm.fullAddress || (manualForm.locality ? `${manualForm.locality}, ${manualForm.city}` : `${manualForm.city}, ${manualForm.state}`)),
        locality: locMode === "manual" ? manualForm.locality : ((savedAddress as any)?.locality || ""),
        detectedArea: locMode === "map" ? (preview.address || "") : "",
        city: locMode === "saved"
          ? (savedAddress?.city || "")
          : locMode === "map"
            ? (preview.city || "")
            : (manualForm.city || ""),
        state: locMode === "saved"
          ? (savedAddress?.state || "")
          : locMode === "map"
            ? (preview.state || "")
            : manualForm.state,
        zipCode: locMode === "saved"
          ? (savedAddress?.zipCode || "")
          : locMode === "map"
            ? (preview.zipCode || "")
            : manualForm.zipCode,
        lat: position?.[0] ?? null,
        lng: position?.[1] ?? null,
        isGpsLocked: locMode === "map",
      };

      onClose();
      navigate("/checkout", {
        state: {
          addressPrefill,
          shippingCharge: preview.shippingCharge,
          buyNowProductId: product?.id,
          buyNowVariantId: product?.variantId,
        },
      });
    } catch (err: any) {
      if (err?.message !== "Not authenticated") {
        toast.error("Something went wrong. Please try again.");
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const goBackToSelect = () => {
    setPhase("select");
    setPreview(null);
    setLocMode(null);
    setPosition(null);
  };

  const estimatedTotal = orderSubtotal + (preview?.shippingCharge ?? 0);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="delivery-location-portal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="fixed inset-0 z-[150] flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-slate-900/60 cursor-pointer"
            onClick={onClose}
          />

          {/* Modal Card */}
          <motion.div
            key="delivery-location-card"
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="relative z-10 w-full max-w-lg bg-white shadow-2xl rounded-3xl flex flex-col max-h-[85vh] cursor-default border border-slate-100 overflow-hidden"
          >
              {/* Header */}
              <div className="px-6 py-4 border-b border-slate-100 bg-white sticky top-0 z-10">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {phase !== "select" ? (
                      <button
                        onClick={goBackToSelect}
                        className="p-2 rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
                        aria-label="Go back"
                      >
                        <ChevronLeftIcon className="h-5 w-5 stroke-[2.5]" />
                      </button>
                    ) : (
                      <div className="w-10 h-10 rounded-2xl bg-indigo-50 border border-indigo-100/60 flex items-center justify-center text-indigo-600">
                        <TruckIcon className="h-5 w-5 stroke-[2]" />
                      </div>
                    )}
                    <div>
                      <h2 className="text-base font-bold text-slate-900 tracking-tight">Delivery Location</h2>
                      <p className="text-xs text-slate-500 font-medium truncate max-w-[210px]">
                        {product ? product.name : `${cartItems.length} item${cartItems.length !== 1 ? "s" : ""} in cart`}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={onClose}
                    className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
                    aria-label="Close"
                  >
                    <XMarkIcon className="h-5 w-5 stroke-[2]" />
                  </button>
                </div>
              </div>

              {/* Body Content */}
              <div className="px-6 py-5 overflow-y-auto flex-1 bg-slate-50/50">

                {/* ── PHASE: SELECT ── */}
                {phase === "select" && (
                  <div className="space-y-3.5">
                    <div className="mb-2">
                      <p className="text-sm font-semibold text-slate-800">Where should we deliver?</p>
                      <p className="text-xs text-slate-500">Select an address option to compute shipping costs.</p>
                    </div>

                    {/* Saved Address Button */}
                    {addressLoading ? (
                      <div className="w-full flex items-center gap-4 rounded-2xl border border-slate-200/80 bg-slate-50/60 p-4 animate-pulse">
                        <div className="w-11 h-11 rounded-xl bg-slate-200 shrink-0" />
                        <div className="flex-1 space-y-2">
                          <div className="h-4 w-32 bg-slate-200 rounded" />
                          <div className="h-3 w-48 bg-slate-100 rounded" />
                        </div>
                      </div>
                    ) : savedAddress ? (
                      <button
                        type="button"
                        onClick={handleSelectSaved}
                        disabled={calcLoading}
                        className={`w-full flex items-center gap-4 rounded-2xl border p-4 text-left transition-all bg-white shadow-xs cursor-pointer active:scale-[0.99] ${
                          locMode === "saved"
                            ? "border-emerald-600 ring-2 ring-emerald-600/10"
                            : "border-slate-200 hover:border-emerald-300 hover:shadow-md hover:bg-emerald-50/20"
                        }`}
                      >
                        <div className="w-11 h-11 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center shrink-0">
                          {calcLoading && locMode === "saved" ? (
                            <BeatLoader size={5} color="#059669" />
                          ) : (
                            <HomeIcon className="h-5 w-5 text-emerald-600 stroke-[2]" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <p className="font-semibold text-slate-900 text-sm">Saved Default Address</p>
                            <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-100">Default</span>
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5 truncate font-medium">
                            {savedAddress.fullAddress || `${savedAddress.city}, ${savedAddress.state}`}
                          </p>
                        </div>
                      </button>
                    ) : (
                      <div className="w-full flex items-center gap-4 rounded-2xl border border-dashed border-slate-200 bg-slate-100/50 p-4 opacity-60 cursor-not-allowed">
                        <div className="w-11 h-11 rounded-xl bg-slate-200/60 flex items-center justify-center shrink-0">
                          <HomeIcon className="h-5 w-5 text-slate-400 stroke-[2]" />
                        </div>
                        <div>
                          <p className="font-semibold text-slate-500 text-sm">No Saved Address</p>
                          <p className="text-xs text-slate-400 mt-0.5">Add an address inside your profile settings</p>
                        </div>
                      </div>
                    )}

                    {/* Manual Form Button */}
                    <button
                      type="button"
                      onClick={() => { setLocMode("manual"); setPhase("manual_form"); }}
                      disabled={calcLoading}
                      className={`w-full flex items-center gap-4 rounded-2xl border p-4 text-left transition-all bg-white shadow-xs cursor-pointer active:scale-[0.99] ${
                        locMode === "manual"
                          ? "border-amber-600 ring-2 ring-amber-600/10"
                          : "border-slate-200 hover:border-amber-300 hover:shadow-md hover:bg-amber-50/20"
                      }`}
                    >
                      <div className="w-11 h-11 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center shrink-0">
                        <PencilSquareIcon className="h-5 w-5 text-amber-600 stroke-[2]" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-slate-900 text-sm">Enter Qatar Address</p>
                        <p className="text-xs text-slate-500 mt-0.5">Type in custom destination details</p>
                      </div>
                    </button>
                  </div>
                )}

                {/* ── PHASE: MANUAL FORM ── */}
                {phase === "manual_form" && (
                  <div className="space-y-4">
                    <div className="mb-1">
                      <p className="text-sm font-semibold text-slate-800">Enter Delivery Details</p>
                      <p className="text-xs text-slate-500">Enter your address and select a municipality.</p>
                    </div>

                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 flex items-center justify-between">
                        <span>P.O. Box <span className="font-normal normal-case">(optional)</span></span>
                      </label>
                      <div>
                        <input
                          type="text"
                          value={manualForm.zipCode}
                          onChange={handlePoBoxChange}
                          placeholder="Enter P.O. Box (optional)"
                          maxLength={20}
                          className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-600 focus:ring-2 focus:ring-indigo-600/10 focus:outline-none transition shadow-xs font-mono"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 flex items-center justify-between">
                        <span>Full Address <span className="text-rose-500">*</span></span>
                      </label>
                      <textarea
                        ref={addressInputRef}
                        value={manualForm.fullAddress}
                        onChange={(e) => {
                          setManualForm((f) => ({ ...f, fullAddress: e.target.value }));
                          if (addressError) setAddressError(null);
                        }}
                        placeholder="Zone, Street, Building / Villa, Area..."
                        rows={2}
                        className={`w-full rounded-2xl border px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none transition resize-none shadow-xs ${
                          addressError
                            ? "border-rose-400 ring-2 ring-rose-100 bg-rose-50/20"
                            : "border-slate-200 bg-white focus:border-indigo-600 focus:ring-2 focus:ring-indigo-600/10"
                        }`}
                      />
                      {addressError && (
                        <p className="text-[11px] font-medium text-rose-600 mt-1 flex items-center gap-1">
                          <span>•</span> {addressError}
                        </p>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">City / Area</label>
                        <input
                          type="text"
                          value={manualForm.city}
                          onChange={(e) => setManualForm((prev) => ({ ...prev, city: e.target.value }))}
                          placeholder="Enter your city or area"
                          className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs text-slate-900 font-medium focus:outline-none focus:border-indigo-600"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Municipality</label>
                        <select
                          value={manualForm.state}
                          onChange={(e) => setManualForm((prev) => ({ ...prev, state: e.target.value }))}
                          className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs text-slate-900 font-medium focus:outline-none focus:border-indigo-600"
                        >
                          <option value="">Select municipality</option>
                          {QATAR_MUNICIPALITIES.map((mun) => <option key={mun} value={mun}>{mun}</option>)}
                        </select>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={handleManualCalculate}
                      disabled={calcLoading || !manualForm.state.trim()}
                      className="w-full rounded-2xl bg-slate-900 py-3.5 text-sm font-semibold text-white hover:bg-slate-800 active:scale-[0.99] disabled:opacity-50 transition-all flex items-center justify-center gap-2 mt-3 shadow-md cursor-pointer"
                    >
                      {calcLoading ? (
                        <BeatLoader size={6} color="#fff" />
                      ) : (
                        <>
                          <TruckIcon className="h-4 w-4 stroke-[2]" />
                          <span>Calculate Rates</span>
                          <ArrowRightIcon className="h-3.5 w-3.5 stroke-[2.5]" />
                        </>
                      )}
                    </button>
                  </div>
                )}

                {/* ── PHASE: PREVIEW ── */}
                {phase === "preview" && preview && (
                  <div className="space-y-4">
                    {/* Map — click/drag to re-point the pin and recalculate shipping */}
                    {position && (
                      <div className="rounded-2xl overflow-hidden border border-slate-200/80 shadow-xs relative" style={{ height: 170 }}>
                        <MapContainer
                          center={position}
                          zoom={15}
                          minZoom={4}
                          maxBounds={QATAR_BOUNDS}
                          maxBoundsViscosity={1.0}
                          style={{ height: "100%", width: "100%", cursor: repositioning ? "wait" : "pointer" }}
                          zoomControl={!repositioning}
                          dragging={!repositioning}
                          doubleClickZoom={!repositioning}
                          scrollWheelZoom={!repositioning}
                          touchZoom={!repositioning}
                          boxZoom={false}
                          keyboard={false}
                        >
                          <TileLayer
                            attribution='&copy; <a href="https://osm.org/copyright">OpenStreetMap</a>'
                            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                            referrerPolicy="strict-origin-when-cross-origin"
                          />
                          <Marker position={position} icon={customIcon} />
                          <MapRecenter center={position} />
                          {!repositioning && <MapClickHandler onPick={handleRepositionPin} />}
                        </MapContainer>
                        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur-sm border border-slate-200 rounded-full px-3 py-1 text-[10px] font-medium text-slate-600 shadow pointer-events-none z-[1000]">
                          {repositioning ? "Recalculating…" : "Tap the map to move the pin"}
                        </div>
                        {repositioning && (
                          <div className="absolute inset-0 bg-white/50 flex items-center justify-center z-[999]">
                            <BeatLoader size={6} color="#4f46e5" />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Delivery summary card */}
                    <div className="flex items-start gap-3 bg-white rounded-2xl border border-slate-200/80 p-3.5 shadow-xs">
                      <div className="w-8 h-8 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
                        <MapPinIcon className="h-4 w-4 text-indigo-600 stroke-[2]" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Destination</p>
                        {locMode === "saved" && savedAddress ? (
                          <>
                            <p className="text-xs font-semibold text-slate-900 mt-0.5 break-words">
                              {savedAddress.fullAddress || `${savedAddress.city}, ${savedAddress.state}${savedAddress.zipCode ? `, P.O. Box ${savedAddress.zipCode}` : ""}`}
                            </p>
                            <p className="text-[11px] text-slate-500 mt-0.5">{savedAddress.city}, {savedAddress.state}{savedAddress.zipCode ? ` · P.O. Box ${savedAddress.zipCode}` : ""}</p>
                          </>
                        ) : locMode === "map" ? (
                          <>
                            <p className="text-xs font-semibold text-slate-900 mt-0.5 break-words">
                              {preview.address || "Selected Map Location"}
                            </p>
                            {preview.state && <p className="text-[11px] text-slate-500 mt-0.5">{preview.state}</p>}
                          </>
                        ) : (
                          <>
                            <p className="text-xs font-semibold text-slate-900 mt-0.5 break-words">
                              {manualForm.fullAddress || `${manualForm.city}, ${manualForm.state}`}
                            </p>
                            <p className="text-[11px] text-slate-500 mt-0.5">{manualForm.city}, {manualForm.state}{manualForm.zipCode ? ` · P.O. Box ${manualForm.zipCode}` : ""}</p>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Order summary breakdown */}
                    <div className="rounded-2xl border border-slate-200/80 bg-white shadow-xs overflow-hidden">
                      <div className="px-4 py-2.5 bg-slate-100/50 border-b border-slate-100 flex items-center justify-between">
                        <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Order Summary</p>
                        <ShieldCheckIcon className="h-4 w-4 text-emerald-600" />
                      </div>
                      <div className="p-4 space-y-2.5 text-xs">
                        <div className="space-y-1.5 max-h-28 overflow-y-auto pr-1">
                          {orderLines.map((line, i) => (
                            <div key={i} className="flex justify-between items-center text-slate-600">
                              <span className="truncate pr-2 font-medium">
                                {line.name} {line.quantity > 1 ? `(x${line.quantity})` : ""}
                              </span>
                              <span className="font-semibold text-slate-900 shrink-0">
                                QAR {(line.price * line.quantity).toLocaleString("en-QA")}
                              </span>
                            </div>
                          ))}
                        </div>

                        <div className="flex justify-between items-start text-slate-600 pt-1 border-t border-slate-100">
                          <div>
                            <span className="font-medium">Shipping Fee</span>
                            <p className="text-[10px] text-slate-400 mt-0.5 max-w-[200px]">{preview.label}</p>
                          </div>
                          <span className={`font-bold shrink-0 ${preview.shippingCharge === 0 ? "text-emerald-600" : "text-slate-900"}`}>
                            {preview.shippingCharge === 0 ? "FREE" : `QAR ${preview.shippingCharge}`}
                          </span>
                        </div>

                        <div className="flex justify-between items-center pt-3 border-t border-slate-100">
                          <span className="font-bold text-slate-900 text-sm">Estimated Total</span>
                          <span className="font-bold text-base text-slate-900">QAR {estimatedTotal.toLocaleString("en-QA")}</span>
                        </div>
                      </div>

                      <div className="bg-amber-50/70 px-4 py-2 border-t border-amber-100/80">
                        <p className="text-[10px] font-medium text-amber-800/90 leading-tight">
                          * Final total includes all cart items. Delivery charge confirmed at final step.
                        </p>
                      </div>
                    </div>

                    {/* Proceed Action Button */}
                    <button
                      type="button"
                      onClick={handleProceed}
                      disabled={isProcessing}
                      className="w-full rounded-2xl bg-indigo-600 py-3.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-indigo-700 active:scale-[0.99] disabled:opacity-60 transition-all shadow-md shadow-indigo-600/20 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      {isProcessing ? (
                        <BeatLoader size={6} color="#fff" />
                      ) : (
                        <>
                          <CheckCircleIcon className="h-4 w-4 stroke-[2]" />
                          <span>Proceed to Checkout</span>
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}