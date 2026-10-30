import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_SECONDS = 15 * 60;
const MAC_BYTES = 32;
const PREFIX = "protected_media_";
function mac(secret, value) { return createHmac("sha256", secret).update(value).digest("base64url"); }
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function usableSecret(secret) { return typeof secret === "string" && Buffer.byteLength(secret) >= MAC_BYTES; }
export function cookieName(slug) { return PREFIX + createHash("sha256").update(slug).digest("hex").slice(0, 24); }
export function passwordMatches(secret, actual, supplied) {
  if (!usableSecret(secret) || typeof actual !== "string" || !actual.trim() || typeof supplied !== "string") return false;
  return equal(mac(secret, `password:${actual}`), mac(secret, `password:${supplied}`));
}
export function createMediaToken(secret, slug, password, now = Date.now(), revision = "") {
  if (!usableSecret(secret) || typeof slug !== "string" || !slug || typeof password !== "string" || !password.trim()) throw new Error("Invalid session input");
  const payload = Buffer.from(JSON.stringify({ v: 1, slug, exp: Math.floor(now / 1000) + TOKEN_TTL_SECONDS, nonce: randomBytes(32).toString("base64url"), proof: mac(secret, `proof:${slug}\0${revision}\0${password}`) })).toString("base64url");
  return `${payload}.${mac(secret, `token:${payload}`)}`;
}
export function verifyMediaToken(secret, token, slug, password, now = Date.now(), revision = "") {
  if (!usableSecret(secret) || typeof token !== "string" || token.length > 2048 || typeof password !== "string" || !password.trim()) return false;
  const parts = token.split(".");
  if (parts.length !== 2 || !equal(parts[1], mac(secret, `token:${parts[0]}`))) return false;
  try {
    const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return data.v === 1 && data.slug === slug && Number.isInteger(data.exp) && data.exp > Math.floor(now / 1000) && typeof data.nonce === "string" && equal(data.proof, mac(secret, `proof:${slug}\0${revision}\0${password}`));
  } catch { return false; }
}
export function documentHasSession(secret, cookies, doc, now = Date.now()) {
  if (!doc?.slug || !doc?.metadata || doc.metadata.draft) return false;
  const pwd = doc.metadata.password;
  if (pwd === undefined || !String(pwd).trim()) return false;
  const name = cookieName(doc.slug);
  for (const part of (cookies ?? "").split(";").slice(0, 64)) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    if (verifyMediaToken(secret, part.slice(index + 1).trim(), doc.slug, String(pwd), now, `${doc.documentId ?? ""}\0${doc.updatedAt ?? ""}`)) return true;
  }
  return false;
}
export const sessionTtlSeconds = TOKEN_TTL_SECONDS;
