function bytesToBase64Url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

// URL-only single-bundle links retain the original 8 MiB ceiling. Reviewed
// pair snapshots and their encrypted transports use the complete-artifact
// ceiling exported by stored-share.js instead.
export const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;

export async function readBounded(stream, limit) {
  const reader = stream.getReader();
  const bytes = new Uint8Array(limit);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > limit - length) {
        void reader.cancel().catch(() => {});
        throw new RangeError("Share is too large to open safely. Ask for an exported bundle.");
      }
      bytes.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.slice(0, length);
}

async function transformBytes(bytes, stream, limit = MAX_PLAINTEXT_BYTES) {
  const transformed = new Blob([bytes]).stream().pipeThrough(stream);
  return readBounded(transformed, limit);
}

export function compressBytes(bytes, limit = MAX_PLAINTEXT_BYTES) {
  return transformBytes(bytes, new CompressionStream("deflate-raw"), limit);
}

export async function decompressBytes(bytes, limit = MAX_PLAINTEXT_BYTES) {
  try {
    return await transformBytes(bytes, new DecompressionStream("deflate-raw"), limit);
  } catch (error) {
    if (error instanceof RangeError) throw error;
    return transformBytes(bytes, new DecompressionStream("deflate"), limit);
  }
}

export async function encodeBundle(bundle) {
  return encodeShareJson(JSON.stringify(bundle));
}

// Preserve an already-reviewed artifact's serialized bytes, without preparing it again.
export async function encodeShareJson(text, plaintextLimit = MAX_PLAINTEXT_BYTES, encodedLimit = plaintextLimit) {
  const json = new TextEncoder().encode(text);
  if (json.length > plaintextLimit) throw new RangeError(`Bundle exceeds the ${plaintextLimit / 1024 / 1024} MiB sharing limit. Export the bundle instead.`);
  const compressed = await compressBytes(json, encodedLimit);
  return `#b=${bytesToBase64Url(compressed)}`;
}

export async function decodeBundle(hash, plaintextLimit = MAX_PLAINTEXT_BYTES, encodedLimit = plaintextLimit) {
  if (hash.length > Math.ceil(encodedLimit * 4 / 3) + 3) throw new RangeError("Share link is too large.");
  const match = /^#([bj])=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match) throw new TypeError("Share link must use #b= or #j= encoding.");

  let bytes = base64UrlToBytes(match[2]);
  if (match[1] === "b") {
    // M1 links used zlib-wrapped DEFLATE before raw DEFLATE became canonical.
    bytes = await decompressBytes(bytes, plaintextLimit);
  }
  if (bytes.length > plaintextLimit) throw new RangeError("Share is too large.");
  return JSON.parse(new TextDecoder().decode(bytes));
}
