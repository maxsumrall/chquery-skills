#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { stdin } from "node:process";

import { getCliCapabilities, getCliVersion } from "./cli-metadata.mjs";
import { validateBundle } from "../lib/bundle.js";
import { validateComparisonEvidence } from "../lib/comparison-artifact.js";
import { comparisonToMarkdown, createOutgoingReviewEnvelope, prepareBundleForReview, prepareComparison } from "../lib/comparison-report.js";
import { compareBundles, comparisonBriefInput } from "../lib/comparison.js";
import { configureSettingsKnowledge } from "../lib/findings.js";
import { prepareInvestigation } from "../lib/investigation-handoff.js";
import { validateInvestigation } from "../lib/investigation.js";
import { bundleToBriefJson, bundleToBriefMarkdown, bundleToJson, bundleToMarkdown } from "../lib/report.js";
import { briefFromComparison, comparisonBriefToJson, comparisonBriefToMarkdown } from "../lib/report.js";
import { runHandoffSender } from "../lib/handoff-transport.js";
import { encodeShareJson } from "../lib/share.js";

const ANALYZE_USAGE = "Usage: chquery analyze <review.json|-> [--format md|json] [--output brief|full|link] [--link] [--include-literals] [--identifiers retain|pseudonymize]";
const HANDOFF_USAGE = "Usage: chquery handoff <review.json|-> [--include-literals] [--identifiers retain|pseudonymize]";
const USAGE = `${ANALYZE_USAGE}\n       ${HANDOFF_USAGE}`;

const cliArguments = process.argv.slice(2);
if (cliArguments.length === 1 && ["--version", "-v"].includes(cliArguments[0])) {
  console.log(await getCliVersion());
  process.exit(0);
}
if (cliArguments.length === 1 && cliArguments[0] === "capabilities") {
  console.log(JSON.stringify(await getCliCapabilities({
    analyzeOutputs: ["brief", "full-report", "link-only", "runtime-samples-v1"],
    discoveryExecutable: "chquery",
    temporaryHandoff: true
  }), null, 2));
  process.exit(0);
}

const [settingsCatalog, settingsConcerns] = await Promise.all([
  readFile(new URL("../data/settings-catalog.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../data/settings-concerns.json", import.meta.url), "utf8").then(JSON.parse)
]);
configureSettingsKnowledge(settingsCatalog, settingsConcerns);

class UsageError extends Error {}

async function readStdin() {
  let input = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) input += chunk;
  return input;
}

function parseArguments(arguments_) {
  if (arguments_.includes("--help") || arguments_.includes("-h")) return { help: true };
  if (arguments_[0] === "handoff") {
    const options = { command: "handoff", includeLiterals: false, identifiers: "retain" };
    const paths = [];
    for (let index = 1; index < arguments_.length; index += 1) {
      const argument = arguments_[index];
      if (argument === "--include-literals") options.includeLiterals = true;
      else if (argument === "--identifiers") {
        const identifiers = arguments_[index + 1];
        if (!identifiers || !["retain", "pseudonymize"].includes(identifiers)) throw new UsageError(HANDOFF_USAGE);
        options.identifiers = identifiers;
        index += 1;
      } else if (argument.startsWith("-") && argument !== "-") throw new UsageError(HANDOFF_USAGE);
      else paths.push(argument);
    }
    if (paths.length !== 1) throw new UsageError(HANDOFF_USAGE);
    return { ...options, path: paths[0] };
  }
  if (arguments_[0] !== "analyze") throw new UsageError(USAGE);

  const options = { command: "analyze", format: "md", output: "brief", link: false, includeLiterals: false };
  const paths = [];
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--format") {
      const format = arguments_[index + 1];
      if (!format || !["md", "json"].includes(format)) throw new UsageError(USAGE);
      options.format = format;
      index += 1;
    } else if (argument === "--output") {
      const output = arguments_[index + 1];
      if (!output || !["brief", "full", "link"].includes(output)) throw new UsageError(USAGE);
      options.output = output;
      index += 1;
    } else if (argument === "--link") {
      options.link = true;
    } else if (argument === "--include-literals") {
      options.includeLiterals = true;
    } else if (argument === "--identifiers") {
      const identifiers = arguments_[index + 1];
      if (!["retain", "pseudonymize"].includes(identifiers)) throw new UsageError(USAGE);
      options.identifiers = identifiers;
      index += 1;
    } else if (argument.startsWith("-") && argument !== "-") {
      throw new UsageError(USAGE);
    } else {
      paths.push(argument);
    }
  }
  if (options.output === "link") options.link = true;
  if (paths.length !== 1 || ((options.includeLiterals || options.identifiers) && !options.link)) throw new UsageError(USAGE);
  return { ...options, path: paths[0] };
}

async function main() {
  const options = parseArguments(cliArguments);
  if (options.help) {
    console.log(USAGE);
    return;
  }

  let artifact;
  try {
    const source = options.path === "-" ? await readStdin() : await readFile(options.path, "utf8");
    artifact = JSON.parse(source);
  } catch (error) {
    console.error(JSON.stringify([{ path: "$", code: "json", message: error.message }], null, 2));
    process.exitCode = 1;
    return;
  }

  if (Array.isArray(artifact)) {
    console.error(JSON.stringify([{ path: "$", code: "role-selection-required",
      message: "Choose one bundle for a single query, or explicitly map baseline and candidate bundles in a chquery_comparison:1 artifact. Names such as current, production, or PR do not establish roles." }], null, 2));
    process.exitCode = 1;
    return;
  }

  const kind = artifact?.chquery_investigation === 1 ? "investigation"
    : artifact?.chquery_comparison === 1 ? "comparison" : "bundle";
  const validation = kind === "investigation" ? validateInvestigation(artifact)
    : kind === "comparison" ? validateComparisonEvidence(artifact) : validateBundle(artifact);
  if (!validation.valid) {
    console.error(JSON.stringify(validation.errors, null, 2));
    process.exitCode = 1;
    return;
  }

  if (options.command === "handoff") {
    const reviewOptions = { redact: !options.includeLiterals, identifiers: options.identifiers };
    const prepared = kind === "investigation" ? prepareInvestigation(artifact, reviewOptions)
      : kind === "comparison" ? prepareComparison(artifact, reviewOptions)
        : prepareBundleForReview(artifact, reviewOptions);
    const envelope = await createOutgoingReviewEnvelope(prepared);
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error("Temporary handoff interrupted. Local evidence was retained."));
    process.once("SIGINT", interrupt);
    try {
      await runHandoffSender(envelope.bytes, {
        disclosureJson: envelope.disclosureJson,
        signal: controller.signal,
        onInvitation: ({ href }) => process.stdout.write(`${href}\n`),
        onProgress: progress => {
          const transferred = progress.state === "uploading" && Number.isInteger(progress.loaded) && Number.isInteger(progress.total)
            ? ` ${progress.loaded}/${progress.total} bytes` : "";
          process.stderr.write(`Handoff: ${progress.state}${transferred}\n`);
        }
      });
    } finally {
      process.removeListener("SIGINT", interrupt);
    }
    return;
  }

  let outgoing = artifact;
  let prepared = null;
  let link = null;
  if (options.link) {
    const reviewOptions = { redact: !options.includeLiterals, identifiers: options.identifiers || "retain" };
    prepared = kind === "investigation" ? prepareInvestigation(artifact, reviewOptions)
      : kind === "comparison" ? prepareComparison(artifact, reviewOptions)
        : prepareBundleForReview(artifact, reviewOptions);
    outgoing = prepared.artifact;
    if (typeof prepared.json !== "string") throw new Error("Exact prepared JSON is unavailable for this review type.");
    link = `https://chquery.com/${await encodeShareJson(prepared.json)}`;
    const summary = outgoing.redaction?.summary || prepared.preparation.transformation;
    console.error(`Preparation: ${summary}. ${prepared.preparation.warning}`);
    if (link.length > 16 * 1024) console.error("Warning: this URL exceeds about 16 KB; share the redacted bundle file instead.");
  }

  let output;
  if (options.output === "link") output = options.format === "json" ? JSON.stringify({ chqueryLink: 1, link }) : link;
  else if (kind === "investigation") {
    if (options.output === "full") {
      const reviewed = prepared || prepareInvestigation(outgoing, { redact: false });
      output = options.format === "json" ? reviewed.reportJson : reviewed.markdown;
    } else if (outgoing.evidence.chquery_comparison === 1) {
      const report = prepared?.report.analysis || compareBundles(outgoing.evidence);
      const brief = briefFromComparison(comparisonBriefInput(report), {
        link, name: outgoing.title, question: outgoing.problem
      });
      output = options.format === "json" ? comparisonBriefToJson(brief) : comparisonBriefToMarkdown(brief);
    } else {
      const briefOptions = { link, name: outgoing.title, question: outgoing.problem };
      output = options.format === "json" ? bundleToBriefJson(outgoing.evidence, briefOptions) : bundleToBriefMarkdown(outgoing.evidence, briefOptions);
    }
  } else if (kind === "comparison") {
    const report = prepared?.report || compareBundles(outgoing);
    if (options.output === "full") output = options.format === "json" ? JSON.stringify(report, null, 2) : comparisonToMarkdown(report);
    else {
      const brief = briefFromComparison(comparisonBriefInput(report), { link });
      output = options.format === "json" ? comparisonBriefToJson(brief) : comparisonBriefToMarkdown(brief);
    }
  } else if (options.output === "full") output = options.format === "json" ? bundleToJson(outgoing, { link }) : bundleToMarkdown(outgoing, { link });
  else output = options.format === "json" ? bundleToBriefJson(outgoing, { link }) : bundleToBriefMarkdown(outgoing, { link });
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

main().catch(error => {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  console.error(error.message);
  process.exitCode = 1;
});
