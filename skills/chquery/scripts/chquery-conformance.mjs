#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { stdin } from "node:process";

import { getCliCapabilities } from "./cli-metadata.mjs";
import { EVIDENCE_LIMITS } from "../lib/evidence-contract.js";
import { EvidenceNormalizationError, normalizeEvidence } from "../lib/normalizer.js";
import { ciReviewJson, validateProducerArtifact } from "../lib/producer-contract.js";

const USAGE = "Usage: chquery-conformance --version | capabilities | normalize <input|-> [--kind plan|rows] [--candidate <index|fingerprint>] | validate <artifact.json|-> | review <comparison.json|->";

async function readBoundedText(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > EVIDENCE_LIMITS.wrapperInputBytes) {
      stream.destroy?.();
      const error = new RangeError("Input exceeds the 20 MiB UTF-8 JSON limit.");
      error.diagnostics = [{ severity: "error", path: "$", code: "limit", message: error.message,
        action: "Remove optional evidence without truncating either required plan." }];
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function readSource(path) {
  if (path !== "-" && (await stat(path)).size > EVIDENCE_LIMITS.wrapperInputBytes) {
    const error = new RangeError("Input exceeds the 20 MiB UTF-8 JSON limit.");
    error.diagnostics = [{ severity: "error", path: "$", code: "limit", message: error.message,
      action: "Remove optional evidence without truncating either required plan." }];
    throw error;
  }
  return readBoundedText(path === "-" ? stdin : createReadStream(path));
}

async function readJson(path) {
  const source = await readSource(path);
  try { return JSON.parse(source); }
  catch {
    const failure = new SyntaxError("Invalid JSON.");
    failure.diagnostics = [{ severity: "error", path: "$", code: "json", message: failure.message,
      action: "Supply one complete JSON artifact; do not repair escapes heuristically." }];
    throw failure;
  }
}

async function main() {
  const [command, path, ...rest] = process.argv.slice(2);
  if (["--version", "-v"].includes(command) && path === undefined) {
    console.log((await getCliCapabilities()).tool.version);
    return;
  }
  if (command === "capabilities" && path === undefined) {
    console.log(JSON.stringify(await getCliCapabilities(), null, 2));
    return;
  }
  if (command === "normalize" && path) {
    let kind = "plan", candidate;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === "--kind" && ["plan", "rows"].includes(rest[index + 1])) kind = rest[++index];
      else if (rest[index] === "--candidate" && rest[index + 1]) {
        const value = rest[++index];
        candidate = /^\d+$/.test(value) ? Number(value) : value;
      } else throw new TypeError(USAGE);
    }
    const source = await readSource(path);
    let input;
    try { input = JSON.parse(source); } catch { input = source; }
    try {
      const { value, receipt, diagnostics } = normalizeEvidence(input, { kind, candidate });
      console.log(JSON.stringify({ value, receipt, diagnostics }, null, 2));
    } catch (error) {
      if (!(error instanceof EvidenceNormalizationError)) throw error;
      error.diagnostics = [{ severity: "error", path: error.path, code: error.code, message: error.message,
        action: error.repair, ...(error.details ? { details: error.details } : {}) }];
      throw error;
    }
    return;
  }
  if (!["validate", "review"].includes(command) || !path || rest.length) throw new TypeError(USAGE);
  const value = await readJson(path);
  if (command === "validate") {
    const result = validateProducerArtifact(value);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
    return;
  }
  process.stdout.write(ciReviewJson(value));
}

main().catch(error => {
  console.error(JSON.stringify(error.diagnostics || [{ severity: "error", path: "$", code: "usage",
    message: error.message, action: USAGE }], null, 2));
  process.exitCode = error instanceof TypeError && !error.diagnostics ? 2 : 1;
});
