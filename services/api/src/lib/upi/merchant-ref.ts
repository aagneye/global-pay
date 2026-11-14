/** Normalised payee reference for a UPI QR: "upi:" + the VPA, lowercased. Hashed like PromptPay's (merchantRefHash). */
export function upiMerchantRef(vpa: string): string {
  return `upi:${vpa.toLowerCase()}`;
}
