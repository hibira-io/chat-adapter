import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Checks a `Hibira-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
 * "<t>.<raw body>">` header against the endpoint's signing secret.
 */
export function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) {
    return false;
  }
  let t = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    if (k === "v1") signatures.push(v);
  }
  const ts = Number(t);
  if (!t || !Number.isInteger(ts) || signatures.length === 0) {
    return false;
  }
  if (Math.abs(nowSeconds - ts) > toleranceSeconds) {
    return false;
  }
  const want = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return signatures.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig) || sig.length !== want.length * 2) {
      return false;
    }
    return timingSafeEqual(want, Buffer.from(sig, "hex"));
  });
}

/** Builds a signature header; for tests and local tools. */
export function signPayload(rawBody: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${nowSeconds}.${rawBody}`).digest("hex");
  return `t=${nowSeconds},v1=${v1}`;
}
