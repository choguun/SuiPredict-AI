import { redirect } from "next/navigation";

export default function TradeRedirect() {
  redirect("/legacy/predict/trade");
}
