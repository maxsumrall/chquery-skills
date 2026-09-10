# Producer and transport conformance

CH Query is a connection-free evidence reviewer. This kit lets ClickHouse clients, drivers and MCP servers check portable evidence locally. It does not connect to ClickHouse, execute queries, access GitHub or publish results.

## No-install discovery

From a checkout of this repository with Node.js 20 or newer:

```sh
node bin/chquery-conformance.mjs --version
node bin/chquery-conformance.mjs capabilities
node bin/chquery-conformance.mjs normalize driver-output.json
node bin/chquery-conformance.mjs validate evidence.json
node bin/chquery-conformance.mjs review comparison.json > chquery-review.json
node scripts/validate-producer-conformance.mjs
```

`--version` reports the package version that is running. `capabilities` is the machine-readable source for supported artifact and normalizer versions, commands, collection profiles, transports and limits. The main `chquery` CLI also exposes these discovery routes when its capabilities payload names that executable. Do not infer support from a path or an installation directory. There is no published `npx chquery` command.

Stored-share limits are reported from the running implementation. Temporary handoff limits and states appear only when that executable includes the live `handoff` command; the standalone protocol module alone is not an advertised user capability. A missing handoff capability requires an explicit alternative, not guessed endpoints or an automatic upload.

The optional generated Agent Skill has the same commands under `skills/chquery/scripts/`. Installing that skill is separate from using the no-install checkout or the public browser instructions. Never require a global npm or skill installation to produce one CH Query link.

## Installation scope and tested runtimes

The package declares Node.js `>=20` and has no runtime dependencies. The supported installer is npm using a local project or user-selected prefix; a global install is neither required nor recommended. Release checks exercise direct checkout execution, `npm pack`, an isolated local `npm install`, and the generated skill. The release workflow tests the declared compatibility lines 20, 22 and 24. Other package managers are not claimed as a release-tested installer matrix.

The W7 implementation verification executed this exact local matrix with npm 10.9.9: Node.js 20.20.2, 22.23.2, 24.20.0 and the orb's 26.5.1 runtime. Each run packed the package, installed it into an isolated prefix and exercised the installed commands. CI intentionally names Node major lines rather than freezing patch or bundled npm versions; the check records the exact versions in each run.

If Node.js is unavailable or older than 20, use the browser's manual collector or the documented no-install encoder for a supported local runtime. Do not replace that limitation with an unsolicited global installation.

## Contracts and diagnostics

Schemas in `contracts/` describe the public bundle, comparison, capabilities, diagnostic and deterministic CI-review envelopes. Their HTTPS `$id` values are stable identifiers, not a promise that a validator may fetch them. Load all schemas from the local `contracts/` directory so relative references resolve offline. Runtime validation is also required because it enforces finite byte, depth, node and sample budgets that JSON Schema alone cannot express.

Bundles and comparisons may carry top-level `name` and `question` author text. They must be nonblank and are bounded by the runtime contract to 240 and 10,000 JavaScript string units respectively. Pair-side `label`s and `context.claims[]` remain pair-owned fields; do not duplicate them into bundle context. Claims use the advertised `check_type`, canonical W2 source paths and supplied operator properties. References and parser-local node IDs are not identity proof.

`validate` writes one result with `valid`, `artifact` and `diagnostics`. Every diagnostic has:

```json
{
  "severity": "error",
  "path": "candidate.bundle.explain.plan",
  "code": "shape",
  "message": "Invalid Plan node, Plans children, Description or Indexes.",
  "action": "Collect the documented lossless JSON shape and submit it again."
}
```

Paths are data locations, codes are stable machine categories, messages explain this rejection, and actions give a concrete repair. Producers must retain their original input after rejection. Never fetch a URL or local path merely because untrusted evidence contains it.

`normalize` accepts one explicitly supplied lossless transport, auto-detects its supported transport and prints canonical evidence plus a safe receipt. It never prints private extraction paths, artifact names or original wrappers. Use `--kind rows` for decoded row evidence and `--candidate <index|fingerprint>` only after an ambiguity diagnostic. Run `scripts/validate-producer-conformance.mjs` to check the complete reusable corpus without a database connection.

## Collection profiles

- `plan`: original executable SQL and the complete JSON plan. This is the minimum usable profile.
- `review`: plan plus scan estimates, observed server version and changed settings when available.
- `enriched`: review plus explicitly authorized pipeline, schema and associated runtime evidence.

Optional means optional: omitted, observed-empty, denied, unsupported and malformed are distinct states. A profile does not authorize database access, query execution, benchmarking, log reads or collection of private row data. Read the exact profile fields from `capabilities`; do not copy this prose into a version detector.

## Outgoing privacy preparation

Before an external transport receives a comparison, call `prepareComparison` once with `identifiers: "retain" | "pseudonymize"` and `redact: boolean`. Preview that immutable result and pass the exact bytes returned by `outgoingReviewBytes`; do not serialize the artifact again. Identifier pseudonymization is fail-closed and applies only to the supported surfaces in `PRIVACY_SURFACE_CONTRACT`. It is not anonymization, and unknown identifier-bearing fields require omission or retained identifiers. `createOutgoingReviewEnvelope` provides a bounded safe disclosure without original values, mappings or paths.

Discover these modes from `capabilities.privacyPreparation`. The capability does not authorize a handoff, upload or persistence transport.

## Deterministic PR/CI representation

`review` accepts a complete comparison and emits `chquery_ci_review: 1` JSON with labels, typed claims when the comparison implementation supports them, typed supporting node/setting references, gaps and a concise summary. Source relationships are omitted until the bundle-owned source contract defines them; the producer does not guess from pair context. Keys and unordered lists are stable, so identical evidence and analysis inputs produce identical bytes.

This is an optional integration artifact, not the normal human handoff. The command performs no GitHub API calls, reads no repository metadata, creates no comments and publishes nothing. A CI system must explicitly decide whether and where to retain or publish the output, after applying its own privacy policy.

## Fixture provenance

The conformance manifest labels every case as `genuine`, `sanitized-genuine` or `synthetic`. Genuine cases retain complete collected output and source notes. Synthetic cases exist to exercise wrappers, ambiguity, malformed input, limits and security boundaries; they are not evidence of a real ClickHouse workload or benchmark result. Do not execute queries or collect private database data merely to seed this kit.
