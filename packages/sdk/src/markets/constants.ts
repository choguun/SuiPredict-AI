export const MARKET_PACKAGE_ID =
  process.env.NEXT_PUBLIC_MARKET_PACKAGE_ID ??
  process.env.MARKET_PACKAGE_ID ??
  process.env.AGENT_POLICY_PACKAGE_ID ??
  "0x7377808da2e3d48282268c56e332ac282adca02db3a4d924505fa139067ff4e8";

export const CLOCK_OBJECT_ID = "0x6";

export const DBUSDC_TYPE =
  "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";

export function bpsToPrice(bps: number): number {
  return bps / 10_000;
}

export function priceToBps(price: number): number {
  return Math.round(price * 10_000);
}

export function encodeUtf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}
