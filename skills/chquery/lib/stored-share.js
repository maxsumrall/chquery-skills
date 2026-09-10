import { validateBundle } from "./bundle.js";
import { redactBundle } from "./redact.js";
import { compressBytes, decodeBundle, decompressBytes, readBounded } from "./share.js";
import { assertComparisonEvidence, parseComparisonEvidence } from "./comparison-artifact.js";
import { EVIDENCE_LIMITS } from "./evidence-contract.js";

export const MAX_STORED_PLAINTEXT_BYTES = EVIDENCE_LIMITS.artifactBytes;
export const MAX_STORED_CIPHERTEXT_BYTES = 21 * 1024 * 1024;
export const STORED_SHARE_LIMITS = Object.freeze({
  plaintextBytes: MAX_STORED_PLAINTEXT_BYTES,
  ciphertextBytes: MAX_STORED_CIPHERTEXT_BYTES,
  retentionSeconds: 7 * 24 * 60 * 60
});
const ID = /^[a-f0-9]{32}$/;
const DELETE_TOKEN = /^[a-f0-9]{64}$/;

function apiError(status) {
  const error = new Error({
    403: "Stored sharing is disabled or permission was denied. Use Share link or export the bundle instead.",
    404: "Share not found, deleted or expired. Ask the sender for a new link.",
    413: "Encrypted share exceeds the 21 MiB stored-snapshot limit. Use an offline copy instead.",
    429: "Stored sharing has reached its request limit. Try again later or use Share link.",
  }[status] || "Stored sharing is temporarily unavailable. Try again or use Share link or export the bundle instead.");
  error.status = status;
  return error;
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, signal: AbortSignal.timeout(20000) });
  } catch {
    throw apiError(503);
  }
  if (!response.ok) throw apiError(response.status);
  return response;
}

async function readJson(response) {
  try {
    return JSON.parse(new TextDecoder().decode(await readBounded(response.body, 8192)));
  } catch { throw apiError(503); }
}

export async function getStoredShareConfig() {
  const config = await readJson(await request("/api/shares/config", { cache: "no-store" }));
  if (!config || typeof config.enabled !== "boolean" || !(config.turnstileSiteKey === null ||
      (typeof config.turnstileSiteKey === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(config.turnstileSiteKey)))) {
    throw apiError(503);
  }
  return config;
}

export function validateDeletionReceipt(value) {
  if (!value || typeof value.id !== "string" || typeof value.deleteToken !== "string" || !ID.test(value.id) || !DELETE_TOKEN.test(value.deleteToken)) {
    throw new Error("Invalid deletion receipt. Choose the file saved when you created the link.");
  }
  return { id: value.id, deleteToken: value.deleteToken };
}

export async function deleteStoredShare(receipt) {
  const { id, deleteToken } = validateDeletionReceipt(receipt);
  await request(`/api/shares/${id}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${deleteToken}` }, credentials: "omit"
  });
}

// Objects are single bundles and receive standard redaction. Strings must be the
// exact comparison JSON returned by the confirmed review worker: never redact it twice.
export async function encryptShare(bundleOrReviewedComparisonJson) {
  let json, summary;
  if (typeof bundleOrReviewedComparisonJson === "string") {
    assertComparisonEvidence(parseComparisonEvidence(bundleOrReviewedComparisonJson), { pair: true });
    json = bundleOrReviewedComparisonJson;
    summary = "Exact reviewed comparison snapshot";
  } else {
    if (!validateBundle(bundleOrReviewedComparisonJson).valid ||
        Object.hasOwn(bundleOrReviewedComparisonJson, "chquery_comparison") || Object.hasOwn(bundleOrReviewedComparisonJson, "chquery_investigation")) throw new TypeError("Invalid CH Query bundle.");
    const redacted = redactBundle(bundleOrReviewedComparisonJson);
    json = JSON.stringify(redacted.bundle); summary = redacted.summary;
  }
  if (new TextEncoder().encode(json).length > MAX_STORED_PLAINTEXT_BYTES) {
    throw new RangeError("Snapshot exceeds the 20 MiB sharing limit. No partial snapshot was prepared.");
  }
  const encoded = await compressBytes(new TextEncoder().encode(json), MAX_STORED_CIPHERTEXT_BYTES - 29);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded));
  const payload = new Uint8Array(1 + iv.length + encrypted.length);
  payload[0] = 2;
  payload.set(iv, 1);
  payload.set(encrypted, 13);
  if (payload.length > MAX_STORED_CIPHERTEXT_BYTES) throw new Error("Encrypted share exceeds the 21 MiB stored-snapshot limit. Use an offline copy.");
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  const secret = btoa(String.fromCharCode(...rawKey)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return { payload, secret, summary };
}

export async function createStoredShare(bundleOrReviewedComparisonJson, turnstileToken = "") {
  const { payload, secret, summary } = await encryptShare(bundleOrReviewedComparisonJson);
  const headers = { "Content-Type": "application/octet-stream" };
  if (turnstileToken) headers["X-Turnstile-Token"] = turnstileToken;
  const response = await request("/api/shares", {
    method: "POST", headers, body: payload, credentials: "omit"
  });
  const { id, expiresAt, deleteToken } = await readJson(response) || {};
  if (typeof id !== "string" || typeof deleteToken !== "string" || !ID.test(id) || !DELETE_TOKEN.test(deleteToken) || !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() || expiresAt > Date.now() + 8 * 86400000) throw new Error("Invalid share response. Use Share link instead.");
  const url = new URL("/", window.location.href);
  url.hash = `s=${id}.${secret}`;
  return { href: url.href, summary, id, expiresAt, deleteToken };
}

export async function decryptShare(payload, secret) {
  if (payload.length > MAX_STORED_CIPHERTEXT_BYTES || payload.length < 30 || ![1, 2].includes(payload[0])) {
    throw new Error("Invalid encrypted share.");
  }
  const raw = Uint8Array.from(atob(secret.replaceAll("-", "+").replaceAll("_", "/") + "="), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: payload.slice(1, 13) }, key, payload.slice(13)));
  const bundle = payload[0] === 1
    ? await decodeBundle(new TextDecoder().decode(plaintext), MAX_STORED_PLAINTEXT_BYTES, MAX_STORED_CIPHERTEXT_BYTES)
    : JSON.parse(new TextDecoder().decode(await decompressBytes(plaintext, MAX_STORED_PLAINTEXT_BYTES)));
  if (bundle && Object.hasOwn(bundle, "chquery_comparison")) return assertComparisonEvidence(bundle, { pair: true });
  if (Object.hasOwn(bundle || {}, "chquery_investigation")) throw new Error("Invalid CH Query bundle in stored share.");
  return assertComparisonEvidence(bundle);
}

export async function loadStoredShare(hash) {
  const match = /^#s=([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(hash);
  if (!match) throw new Error("Invalid stored-share link.");
  // The fragment (including the key) is never sent to the object API.
  const response = await request(`/api/shares/${match[1]}`, { credentials: "omit", cache: "no-store" });
  if (Number(response.headers.get("Content-Length")) > MAX_STORED_CIPHERTEXT_BYTES) {
    await response.body.cancel();
    throw apiError(413);
  }
  return decryptShare(await readBounded(response.body, MAX_STORED_CIPHERTEXT_BYTES), match[2]);
}

// Only explicit CH Query links are read, never URLs embedded in evidence metadata.
// Production aliases share the same R2 namespace; previews use their own API.
export async function loadShareLink(href, origin = globalThis.location?.origin || "https://chquery.com") {
  let url;
  try { url = new URL(href.trim()); } catch { throw new Error("Paste a complete CH Query analysis or comparison link."); }
  if (![origin, "https://chquery.com", "https://www.chquery.com"].includes(url.origin) ||
      url.pathname !== "/" || url.username || url.password || !/^#[bjs]=/.test(url.hash)) {
    throw new Error("Use a CH Query link with #s=, #b= or #j=. Other websites and file URLs are not supported.");
  }
  return url.hash.startsWith("#s=") ? loadStoredShare(url.hash) : decodeBundle(url.hash);
}
