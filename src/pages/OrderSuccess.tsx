import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useCart } from "../context/CartContext";
import api from "../utils/api";

type VerificationState = "verifying" | "paid" | "pending" | "failed" | "error";

const OrderSuccess = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { fetchCart } = useCart();
  const [state, setState] = useState<VerificationState>("verifying");
  const [resultMessage, setResultMessage] = useState("");

  const provider = searchParams.get("provider");
  const orderId = searchParams.get("orderId");
  const returnResult = searchParams.get("result");

  useEffect(() => {
    let active = true;

    if (provider !== "nomod" || !orderId) {
      setState("error");
      setResultMessage("We could not identify this payment. Please check your orders.");
      return () => {
        active = false;
      };
    }

    api.post("/order/nomod/verify", { orderId })
      .then(async (response) => {
        if (!active) return;
        const paymentStatus = response.data?.paymentStatus;
        if (paymentStatus === "PAID") {
          setState("paid");
          void fetchCart().catch((error) => {
            console.error("Could not refresh cart after confirmed payment", error);
          });
        } else if (paymentStatus === "FAILED") {
          setState("failed");
        } else {
          setState("pending");
        }
      })
      .catch((error) => {
        if (!active) return;
        console.error("Nomod payment verification failed", error);
        setState("error");
        setResultMessage(
          "We could not verify the payment right now. Your order has not been marked paid; please check your orders again shortly.",
        );
      });

    return () => {
      active = false;
    };
  }, [fetchCart, orderId, provider]);

  useEffect(() => {
    if (state !== "paid") return;
    const timer = window.setTimeout(() => {
      navigate("/myorders", { replace: true });
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [navigate, state]);

  const heading = state === "verifying"
    ? "Confirming your payment"
    : state === "paid"
      ? "Payment confirmed"
      : state === "pending"
        ? "Payment is processing"
        : state === "failed"
          ? returnResult === "cancelled" ? "Payment cancelled" : "Payment failed"
          : "Payment status unavailable";

  const message = state === "verifying"
    ? "Please wait while we securely verify your payment with Nomod."
    : state === "paid"
      ? "Your payment is confirmed. Redirecting to your orders..."
      : state === "pending"
        ? "Nomod has not confirmed this payment yet. Check your orders again before retrying."
        : state === "failed"
          ? "Your order was not marked as paid. You can try placing the order again."
          : resultMessage;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <h1
        className={`text-3xl font-bold ${
          state === "paid" ? "text-green-600" : state === "failed" ? "text-rose-600" : "text-slate-800"
        }`}
        style={{ fontFamily: "var(--theme-font-heading)" }}
      >
        {heading}
      </h1>
      <p className="mt-3 max-w-lg text-gray-600">{message}</p>
      {state !== "verifying" && (
        <button
          type="button"
          onClick={() => navigate("/myorders", { replace: true })}
          className="mt-6 rounded-full bg-[var(--theme-primary)] px-6 py-3 text-sm font-bold text-[var(--theme-primary-ink)]"
        >
          View my orders
        </button>
      )}
    </div>
  );
};

export default OrderSuccess;
