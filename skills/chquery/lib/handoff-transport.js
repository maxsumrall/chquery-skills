import { parseComparisonEvidence } from "./comparison-artifact.js";
import { parseInvestigation } from "./investigation.js";
import { compressBytes, decompressBytes, readBounded } from "./share.js";
import { EVIDENCE_LIMITS } from "./evidence-contract.js";
import { MAX_STORED_CIPHERTEXT_BYTES } from "./stored-share.js";

export const HANDOFF_LIMITS = Object.freeze({
  plaintextBytes: EVIDENCE_LIMITS.artifactBytes,
  ciphertextBytes: MAX_STORED_CIPHERTEXT_BYTES,
  invitationSeconds: 15 * 60,
  grantSeconds: 5 * 60,
  temporaryRetentionSeconds: 60 * 60,
  manifestBytes: 4096,
  maxDeflateOverheadBytes: Math.ceil(EVIDENCE_LIMITS.artifactBytes / 16383) * 5 + 6,
  encryptionFramingBytes: 29
});
export const HANDOFF_STATES = Object.freeze(["pending", "granted", "uploading", "ready", "consumed", "denied", "expired"]);

if (HANDOFF_LIMITS.plaintextBytes + HANDOFF_LIMITS.maxDeflateOverheadBytes + HANDOFF_LIMITS.encryptionFramingBytes > HANDOFF_LIMITS.ciphertextBytes) {
  throw new Error("The handoff ciphertext limit does not contain worst-case DEFLATE and AES-GCM framing.");
}

const ID = /^[a-f0-9]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function toBase64Url(bytes) {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomSecret() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function validateArtifactText(json) {
  if (typeof json !== "string" || textEncoder.encode(json).length > HANDOFF_LIMITS.plaintextBytes) {
    throw new RangeError("Prepared evidence exceeds the 20 MiB handoff limit.");
  }
  const value = JSON.parse(json);
  if (value?.chquery_comparison === 1) return { artifact: parseComparisonEvidence(json), kind: "comparison" };
  if (value?.chquery_investigation === 1) return { artifact: parseInvestigation(json), kind: "investigation" };
  if (value?.chquery_investigation !== undefined) throw new TypeError("Handoff evidence must be one valid bundle, complete comparison, or investigation.");
  return { artifact: parseComparisonEvidence(json), kind: "analysis" };
}

function bundleCoverage(bundle) {
  const roots = Array.isArray(bundle?.explain?.plan) ? bundle.explain.plan : [];
  let nodes = 0;
  const stack = roots.flatMap(root => root?.Plan && typeof root.Plan === "object" ? [root.Plan] : []);
  while (stack.length) {
    const node = stack.pop(); nodes++;
    for (const child of node.Plans || []) stack.push(child);
  }
  return { roots: roots.length, nodes, estimates: bundle.explain.estimate?.length || 0,
    schema: bundle.schema?.length || 0, settings: bundle.settings?.changed?.length || 0, runtime: Boolean(bundle.runtime) };
}

function observableCoverage(artifact, kind) {
  if (kind === "analysis") return { single: bundleCoverage(artifact) };
  const evidence = kind === "investigation" ? artifact.evidence : artifact;
  if (evidence.chquery === 1) return { single: bundleCoverage(evidence) };
  const baseline = bundleCoverage(evidence.baseline.bundle), candidate = bundleCoverage(evidence.candidate.bundle);
  return { baseline, candidate };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function validateDisclosure(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("An agent-attested disclosure is required.");
  const json = JSON.stringify(value);
  if (textEncoder.encode(json).length > 2048 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(json)) {
    throw new RangeError("Handoff disclosure exceeds 2 KiB or contains unsupported control characters.");
  }
  if (value.version !== 1 || !Number.isInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > HANDOFF_LIMITS.plaintextBytes ||
      !TOKEN.test(value.sha256 || "") || typeof value.transformation !== "string" || !value.transformation ||
      !value.privacy || typeof value.privacy !== "object" || !value.coverage || typeof value.coverage !== "object") {
    throw new TypeError("Invalid agent-attested disclosure.");
  }
  return JSON.parse(json);
}

export async function prepareHandoff(exactJson, disclosureJson) {
  const json = exactJson instanceof Uint8Array ? new TextDecoder("utf-8", { fatal: true }).decode(exactJson) : exactJson;
  const { kind } = validateArtifactText(json);
  const source = textEncoder.encode(json);
  if (typeof disclosureJson !== "string" || textEncoder.encode(disclosureJson).length > 2048) throw new RangeError("Handoff disclosure exceeds 2 KiB.");
  const disclosure = validateDisclosure(JSON.parse(disclosureJson));
  const plaintextSha256 = await sha256(source);
  if (disclosure.byteLength !== source.length || disclosure.sha256 !== plaintextSha256) {
    throw new Error("Prepared evidence does not match its agent-attested disclosure.");
  }
  const compressed = await compressBytes(source, HANDOFF_LIMITS.ciphertextBytes - 29);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const manifest = {
    version: 1,
    kind,
    plaintextBytes: source.length,
    disclosureJson
  };
  const manifestText = JSON.stringify(manifest);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: textEncoder.encode(disclosureJson) }, key, compressed));
  const payload = new Uint8Array(13 + encrypted.length);
  payload[0] = 3; payload.set(iv, 1); payload.set(encrypted, 13);
  if (payload.length > HANDOFF_LIMITS.ciphertextBytes) throw new RangeError("Encrypted handoff exceeds the 21 MiB transfer limit.");
  return Object.freeze({
    payload,
    key: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", key))),
    manifestText,
    ciphertextSha256: await sha256(payload),
    plaintextBytes: source.length,
    ciphertextBytes: payload.length,
    kind,
    json
  });
}

async function api(path, options = {}, origin = globalThis.location?.origin) {
  let response;
  const target = origin ? new URL(path, origin).href : path;
  try { response = await fetch(target, { ...options, credentials: "omit", cache: "no-store", signal: options.signal || AbortSignal.timeout(20000) }); }
  catch { throw new Error("Temporary transfer is unavailable. The agent keeps the evidence; try again."); }
  if (!response.ok) {
    const error = new Error(response.status === 404 || response.status === 410 ? "This invitation expired or is unavailable. Ask the agent for a new link."
      : response.status === 409 ? "The transfer state changed. Renew authorization before retrying."
      : response.status === 413 ? "The encrypted transfer exceeds the 21 MiB limit."
      : response.status === 429 ? "Temporary transfer is rate-limited. Try again later."
      : response.status === 403 ? "Transfer authorization was denied or expired."
      : "Temporary transfer is unavailable. The agent keeps the evidence; try again.");
    error.status = response.status; throw error;
  }
  return response;
}

async function jsonResponse(response) {
  return JSON.parse(textDecoder.decode(await readBounded(response.body, 8192)));
}

export async function createHandoffInvitation(prepared, origin = globalThis.location?.origin || "https://chquery.com") {
  if (!prepared?.payload || !TOKEN.test(prepared.ciphertextSha256) || prepared.payload.length !== prepared.ciphertextBytes) throw new TypeError("Prepare immutable handoff evidence first.");
  const redeemSecret = randomSecret();
  const expiresAt = Date.now() + HANDOFF_LIMITS.invitationSeconds * 1000;
  const response = await api("/api/handoffs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ciphertextBytes: prepared.ciphertextBytes, ciphertextSha256: prepared.ciphertextSha256,
      redeemSecretHash: await sha256(textEncoder.encode(redeemSecret)), expiresAt })
  }, origin);
  const result = await jsonResponse(response);
  if (!ID.test(result.id) || !TOKEN.test(result.agentToken) || result.expiresAt !== expiresAt) throw new Error("Invalid invitation response.");
  const fragment = [result.id, redeemSecret, prepared.key, toBase64Url(textEncoder.encode(prepared.manifestText))].join(".");
  if (fragment.length > 8192) throw new RangeError("Handoff invitation metadata is too large.");
  return Object.freeze({ ...result, href: `${new URL("/handoff.html", origin).href}#h=${fragment}` });
}

export function parseHandoffInvitation(hash) {
  if (typeof hash !== "string" || hash.length > 8192) throw new RangeError("Handoff invitation metadata is too large.");
  const match = /^#h=([a-f0-9]{32})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match) throw new TypeError("Invalid query-review invitation.");
  const manifestText = textDecoder.decode(fromBase64Url(match[4]));
  if (textEncoder.encode(manifestText).length > HANDOFF_LIMITS.manifestBytes) throw new RangeError("Invitation manifest is too large.");
  const manifest = JSON.parse(manifestText);
  if (manifest?.version !== 1 || !["analysis", "comparison", "investigation"].includes(manifest.kind) ||
      !Number.isInteger(manifest.plaintextBytes) || manifest.plaintextBytes < 1 || manifest.plaintextBytes > HANDOFF_LIMITS.plaintextBytes) {
    throw new TypeError("Invalid query-review manifest.");
  }
  if (typeof manifest.disclosureJson !== "string" || textEncoder.encode(manifest.disclosureJson).length > 2048) throw new RangeError("Invitation disclosure is too large.");
  const disclosure = validateDisclosure(JSON.parse(manifest.disclosureJson));
  return Object.freeze({ id: match[1], redeemSecret: match[2], key: match[3], manifestText, manifest: Object.freeze({ ...manifest, disclosure }) });
}

export async function getHandoffStatus(id, agentToken = "", origin) {
  if (!ID.test(id)) throw new TypeError("Invalid invitation id.");
  const headers = agentToken ? { Authorization: `Bearer ${agentToken}` } : {};
  return jsonResponse(await api(`/api/handoffs/${id}`, { headers }, origin));
}

export async function heartbeatHandoff(id, agentToken, origin) {
  return jsonResponse(await api(`/api/handoffs/${id}/heartbeat`, { method: "POST", headers: { Authorization: `Bearer ${agentToken}` } }, origin));
}

export async function grantHandoff(invitation, turnstileToken = "", origin) {
  const headers = { "Content-Type": "application/json" };
  if (turnstileToken) headers["X-Turnstile-Token"] = turnstileToken;
  return jsonResponse(await api(`/api/handoffs/${invitation.id}/grants`, {
    method: "POST", headers, body: JSON.stringify({ redeemSecret: invitation.redeemSecret })
  }, origin));
}

export async function uploadHandoff(id, agentToken, uploadToken, prepared, onProgress = () => {}, origin) {
  onProgress({ loaded: 0, total: prepared.payload.length });
  await api(`/api/handoffs/${id}/payload`, { method: "PUT", headers: {
    Authorization: `Bearer ${agentToken}`, "X-Upload-Token": uploadToken,
    "Content-Type": "application/octet-stream", "Content-Length": String(prepared.payload.length)
  }, body: prepared.payload }, origin);
  onProgress({ loaded: prepared.payload.length, total: prepared.payload.length });
}

export async function retrieveHandoff(invitation, transferToken, status, origin) {
  const response = await api(`/api/handoffs/${invitation.id}/payload`, {
    method: "POST", headers: { Authorization: `Bearer ${transferToken}` }
  }, origin);
  if (Number(response.headers.get("Content-Length")) > HANDOFF_LIMITS.ciphertextBytes) {
    await response.body.cancel(); throw new RangeError("Encrypted handoff exceeds the 21 MiB transfer limit.");
  }
  const payload = await readBounded(response.body, HANDOFF_LIMITS.ciphertextBytes);
  if (payload.length !== status.ciphertextBytes || await sha256(payload) !== status.ciphertextSha256 || payload[0] !== 3) {
    throw new Error("Transferred evidence failed its ciphertext integrity check.");
  }
  const key = await crypto.subtle.importKey("raw", fromBase64Url(invitation.key), "AES-GCM", false, ["decrypt"]);
  const compressed = await crypto.subtle.decrypt({ name: "AES-GCM", iv: payload.slice(1, 13), additionalData: textEncoder.encode(invitation.manifest.disclosureJson) }, key, payload.slice(13));
  const plaintext = await decompressBytes(new Uint8Array(compressed), HANDOFF_LIMITS.plaintextBytes);
  if (plaintext.length !== invitation.manifest.plaintextBytes) throw new Error("Transferred evidence failed its plaintext size check.");
  if (invitation.manifest.disclosure.byteLength !== plaintext.length || invitation.manifest.disclosure.sha256 !== await sha256(plaintext)) {
    throw new Error("Transferred evidence does not match its agent-attested disclosure.");
  }
  const json = textDecoder.decode(plaintext);
  const { artifact, kind } = validateArtifactText(json);
  if (kind !== invitation.manifest.kind) throw new Error("Transferred evidence does not match its manifest.");
  const coverage = observableCoverage(artifact, kind);
  if (canonicalJson(coverage) !== canonicalJson(invitation.manifest.disclosure.coverage)) {
    throw new Error("Transferred evidence does not match its disclosed observable coverage.");
  }
  return Object.freeze({ artifact, json, manifest: invitation.manifest, observableCoverage: coverage });
}

export async function acknowledgeHandoff(invitation, transferToken, origin) {
  await api(`/api/handoffs/${invitation.id}/ack`, { method: "POST", headers: { Authorization: `Bearer ${transferToken}` } }, origin);
}

export async function declineHandoff(invitation, origin) {
  await api(`/api/handoffs/${invitation.id}/decline`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redeemSecret: invitation.redeemSecret }) }, origin);
}

const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new DOMException("Aborted", "AbortError")); }, { once: true });
});

export async function runHandoffSender(exactJson, { disclosureJson, signal, onInvitation = () => {}, onProgress = () => {},
  origin = "https://chquery.com", pollMilliseconds = 1000 } = {}) {
  const prepared = await prepareHandoff(exactJson, disclosureJson);
  onProgress({ state: "preparing", plaintextBytes: prepared.plaintextBytes, ciphertextBytes: prepared.ciphertextBytes });
  const invitation = await createHandoffInvitation(prepared, origin);
  onInvitation({ href: invitation.href, expiresAt: invitation.expiresAt });
  onProgress({ state: "pending", expiresAt: invitation.expiresAt });
  let lastHeartbeat = 0;
  while (Date.now() < invitation.expiresAt) {
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    try {
      if (Date.now() - lastHeartbeat >= 5000) {
        await heartbeatHandoff(invitation.id, invitation.agentToken, origin); lastHeartbeat = Date.now();
      }
      const status = await getHandoffStatus(invitation.id, invitation.agentToken, origin);
      if (status.state === "denied") {
        const error = new Error("The browser declined temporary transfer. Local evidence was retained."); error.terminal = true; throw error;
      }
      if (status.state === "consumed") { onProgress({ state: "acknowledged" }); return Object.freeze({ state: "acknowledged", invitation }); }
      if (status.state === "granted" && status.uploadToken) {
        onProgress({ state: "uploading", loaded: 0, total: prepared.ciphertextBytes });
        try {
          await uploadHandoff(invitation.id, invitation.agentToken, status.uploadToken, prepared,
            progress => onProgress({ state: "uploading", ...progress }), origin);
          onProgress({ state: "ready", expiresAt: status.grantExpiresAt });
        } catch (error) {
          if (error.status === 413) throw error;
          onProgress({ state: "pending", recoverable: true, message: "Upload was not published. Browser renewal is required." });
        }
      } else if (status.state === "ready") onProgress({ state: "waiting-for-validation", expiresAt: status.grantExpiresAt });
    } catch (error) {
      if (error.terminal || error.status && error.status < 500 && error.status !== 408 && error.status !== 409 && error.status !== 429) throw error;
      onProgress({ state: "pending", recoverable: true, message: error.message });
    }
    await delay(pollMilliseconds, signal);
  }
  throw new Error("The handoff invitation expired. Local evidence was retained.");
}
