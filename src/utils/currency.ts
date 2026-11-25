export type StoreCurrency = "QAR";

export const getStoreCurrency = (_currency?: string | null): StoreCurrency => "QAR";

export const formatCurrency = (
  amount: number,
  currency?: string | null,
): string => {
  const code = getStoreCurrency(currency);
  return new Intl.NumberFormat("en-QA", {
    style: "currency",
    currency: code,
  }).format(amount);
};
