#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EVIDENCE_TRANSPORTS, NORMALIZATION_ERROR_CODES } from "../lib/evidence-contract.js";
import { EvidenceNormalizationError, normalizeEvidence } from "../lib/normalizer.js";
import { validateProducerArtifact } from "../lib/producer-contract.js";

const manifestPath = path.resolve(process.argv[2] || fileURLToPath(new URL("../conformance/manifest.json", import.meta.url)));
const directory = path.dirname(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(manifest.version, 1, "unsupported conformance manifest");

const readInput = async relative => {
  const source = await readFile(path.resolve(directory, relative), "utf8");
  try { return JSON.parse(source); } catch { return source; }
};
let accepted = 0, equivalent = 0, rejected = 0;

for (const item of manifest.cases) {
  assert.ok(["genuine", "sanitized-genuine", "synthetic"].includes(item.provenance), `${item.id}: provenance`);
  assert.equal(typeof item.caseStudy, "boolean", `${item.id}: caseStudy`);
  if (item.kind === "artifact") {
    const result = validateProducerArtifact(await readInput(item.path));
    assert.equal(result.valid, item.expect === "accept", `${item.id}: ${JSON.stringify(result.diagnostics)}`);
    accepted += 1;
    continue;
  }
  assert.equal(item.kind, "transport", `${item.id}: kind`);
  assert.ok(EVIDENCE_TRANSPORTS.includes(item.transport), `${item.id}: transport`);
  const input = await readInput(item.path);
  if (item.expect === "reject") {
    assert.ok(NORMALIZATION_ERROR_CODES.includes(item.code), `${item.id}: error code`);
    assert.throws(() => normalizeEvidence(input, { kind: item.evidenceKind || "plan" }), error => {
      assert.ok(error instanceof EvidenceNormalizationError, item.id);
      assert.equal(error.code, item.code, item.id);
      assert.ok(error.repair, `${item.id}: repair`);
      return true;
    });
    rejected += 1;
    continue;
  }
  assert.equal(item.expect, "equivalent", `${item.id}: expectation`);
  const result = normalizeEvidence(input, { kind: item.evidenceKind || "plan" });
  assert.deepEqual(result.value, await readInput(item.canonical), `${item.id}: canonical value`);
  assert.equal(result.receipt.transport, item.transport, `${item.id}: detected transport`);
  for (const [name, value] of Object.entries(item.facts)) assert.equal(result.receipt[name], value, `${item.id}: ${name}`);
  const receipt = JSON.stringify(result.receipt);
  assert.doesNotMatch(receipt, /privateProvenance|extractionPath|candidatePaths|unknownPlanFieldNames/, `${item.id}: safe receipt`);
  equivalent += 1;
}

console.log(`Producer conformance: ${accepted} artifact case(s) accepted, ${equivalent} transport case(s) equivalent, ${rejected} rejection case(s) precise.`);
