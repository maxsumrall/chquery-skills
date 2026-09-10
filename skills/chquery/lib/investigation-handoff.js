import { stableStringify } from "./comparison-artifact.js";
import { projectBundleForReview, prepareComparison, escapeComparisonMarkdown as md } from "./comparison-report.js";
import { readBundleMeasurements, withMeasurementCoverage } from "./comparison.js";
import { reportFromBundle } from "./report.js";
import { assertInvestigation, freezeInvestigation, INVESTIGATION_LIMITS } from "./investigation.js";
import { assertLocallySaveable } from "./investigation-store.js";
import { byteBudget, checkReportJsonSize, countText, COMPARISON_REPORT_LIMITS } from "./comparison-budget.js";

const outerOmissions = ["title", "problem", "experiment"];
const bundleOmissions = ["schema", "runtime", "settings", "estimate", "pipeline", "syntax"];
const warning = "Review the complete outgoing JSON and Markdown. Private notes and known capability fields are excluded, but identifiers, small numbers, DDL, unsupported plan fields, field names and free text may remain sensitive. This is partial redaction, not anonymization or encryption. No upload or device save has occurred.";

// Unlike the legacy bundle Markdown renderer, every imported prose value passes
// through the shared punctuation encoder. Do not concatenate untrusted Markdown.
function singleMarkdown(report, sql, md, join) {
  const sections = ["## Single-bundle evidence", "No candidate supplied. No comparison or improvement claim is available.",
    `Analysis revision: ${md(report.analysisRevision)}`,
    `Plan nodes: ${md(report.summary.nodeCount)}. Tables read: ${md(report.summary.tablesRead)}.`,
    md(report.coverage.scans.label),
    "### Table scan estimates", "Table-wide estimates are not operator output rows or measured execution time.",
    md(report.summary.tableEstimates),
    "### Runtime observations", md(report.measurements.selectionReason),
    `Selected provenance (unverified): ${md(report.measurements.selectedProvenance)}`,
    "Descriptive observations only. Query-wide runtime cannot establish an operator-level cause, repeatability, or result correctness.",
    ["| Metric | Selected median | Minimum | Maximum | Valid / selected / total |", "| --- | --- | --- | --- | --- |",
      ...Object.entries(report.measurements.summaries).map(([name, summary]) =>
        `| ${md(name)} | ${md(summary.value)} | ${md(summary.min)} | ${md(summary.max)} | ${summary.valid} / ${summary.selected} / ${summary.total} |`)
    ].join("\n"),
    "Duration uses milliseconds; read_bytes/memory_usage use bytes; read_rows/result_rows use counts. Scope follows the supplied provenance; memory is not an inferred cluster peak.",
    "### Samples, exclusions and protocol groups", md({ groups: report.measurements.groups, samples: report.measurements.samples }),
    "### Evidence coverage", md(report.coverage),
    "### Findings"];
  for (const finding of report.findings) {
    sections.push(`#### ${md(finding.id)}`, md(finding.message),
      `Classification: ${md(finding.classification)}. Severity: ${md(finding.severity)}. Impact confidence: ${md(finding.impactConfidence)}.`,
      `Priority: ${md(finding.priorityReason)}`, `Why: ${md(finding.why)}`,
      `Evidence: ${md(finding.evidence)}`, `Evidence scope: ${md(finding.evidenceScope)}`,
      `Next check: ${md(finding.confirmationCheck)}`);
  }
  if (!report.findings.length) sections.push("No findings from supplied evidence. This does not establish correctness or the absence of performance concerns.");
  sections.push("### SQL", sql === null
    ? "Raw SQL omitted from the report, but remains in the portable evidence. Findings and other fields may still contain sensitive SQL descriptions."
    : md(sql));
  return join(sections);
}

/** Prepare once, present these exact strings for review, then copy/download
 * them unchanged. This pure function cannot establish consent or persist data.
 */
export function prepareInvestigation(investigation, {
  redact = true, identifiers = "retain", omit = [], omitSqlFromReport = false, analysis = {}, selectedGroup, intentEvidenceRef
} = {}) {
  assertInvestigation(investigation);
  const pair = investigation.evidence.chquery_comparison === 1;
  const allowed = [...outerOmissions, ...bundleOmissions, ...(pair ? ["context", "labels", "name", "question", "claims", "intents"] : [])];
  if (typeof redact !== "boolean" || !["retain", "pseudonymize"].includes(identifiers) || typeof omitSqlFromReport !== "boolean" || !Array.isArray(omit) || omit.some(key => !allowed.includes(key))) {
    throw new TypeError("Unsupported investigation review options.");
  }
  const evidenceOmissions = omit.filter(key => !outerOmissions.includes(key));
  // Omitting a paired experiment excludes its whole context, including checks
  // whose meaning depends on that experiment. Disclose the context omission.
  if (pair && omit.includes("experiment") && !evidenceOmissions.includes("context")) evidenceOmissions.push("context");
  const prepared = pair
    ? prepareComparison(investigation.evidence, { redact, identifiers, omit: evidenceOmissions, omitSqlFromReport, analysis, intentEvidenceRef })
    : projectBundleForReview(investigation.evidence, { redact, identifiers, omit: evidenceOmissions, intentEvidenceRef });
  const artifact = {
    chquery_investigation: 1,
    title: omit.includes("title") ? "Shared investigation" : investigation.title,
    problem: omit.includes("problem") ? "" : investigation.problem,
    ...(!pair && !omit.includes("experiment") && investigation.proposedExperiment !== undefined
      ? { proposedExperiment: investigation.proposedExperiment } : {}),
    evidence: prepared.artifact
  };
  const preparation = { version: 1, transformation: prepared.preparation.transformation,
    omissions: [...new Set([
      ...(Object.hasOwn(investigation, "notes") ? ["notes"] : []),
      ...(Object.hasOwn(investigation, "preparation") ? ["preparation (untrusted imported manifest)"] : []),
      ...omit.filter(key => outerOmissions.includes(key)),
      ...prepared.preparation.omissions.map(path => `evidence.${path}`)
    ])].sort(), sqlOmittedFromReport: omitSqlFromReport, privacy: prepared.preparation.privacy, warning };
  artifact.preparation = preparation;
  assertInvestigation(artifact);
  // The projection strips named fields, but a recognized capability can also
  // be embedded in author text or required plan content. Refuse that handoff;
  // do not silently alter SQL semantics or claim arbitrary secrets are detected.
  try { assertLocallySaveable(artifact); }
  catch (error) {
    if (error.code !== "capability") throw error;
    const failure = new TypeError("Remove recognizable share links or capability fields from the outgoing evidence before review. Nothing was exported or saved.");
    failure.code = "capability";
    throw failure;
  }

  let evidenceReport;
  let evidenceMarkdown;
  if (pair) {
    evidenceReport = prepared.report;
    evidenceMarkdown = prepared.markdown;
  } else {
    const measurements = readBundleMeasurements(artifact.evidence, { selectedGroup });
    const { catalog = {}, concerns = {} } = analysis;
    const report = reportFromBundle(artifact.evidence, { catalog, concerns });
    evidenceReport = { ...report, coverage: withMeasurementCoverage(report.coverage, measurements, { selectedGroup }), measurements };
    // A fingerprint contains an SQL excerpt. Do not retain it in report-only
    // SQL omission, even though other finding text may still mention SQL.
    if (omitSqlFromReport) evidenceReport.summary = { ...report.summary, fingerprint: null };
    evidenceReport.sql = omitSqlFromReport ? null : artifact.evidence.sql;
  }
  const report = { chquery_investigation_report: 1, title: artifact.title, problem: artifact.problem,
    proposedExperiment: pair ? prepared.artifact.context?.hypothesis || "" : artifact.proposedExperiment || "",
    evidenceKind: pair ? "comparison" : "single", analysis: evidenceReport, preparation };
  // Include wrapper overhead before serializing the expanded report. The
  // shared pair guard alone cannot bound the complete investigation outputs.
  const reportBytes = checkReportJsonSize(report);
  const total = byteBudget("prepared-total", COMPARISON_REPORT_LIMITS.preparedBytes);
  total.add(reportBytes);
  const expansion = byteBudget("markdown");
  if (pair) countText(evidenceMarkdown, count => expansion.add(count));
  const escape = value => {
    const text = typeof value === "object" && value !== null ? stableStringify(value) : String(value ?? "Not supplied");
    countText(text, count => expansion.add(count), "markdown");
    return md(text);
  };
  const join = (parts, newline = false) => {
    const rendered = byteBudget("markdown");
    rendered.add((parts.length - 1) * 2 + (newline ? 1 : 0));
    for (const part of parts) countText(part, count => rendered.add(count));
    return parts.join("\n\n") + (newline ? "\n" : "");
  };
  if (!pair) evidenceMarkdown = singleMarkdown(evidenceReport, evidenceReport.sql, escape, join);
  const markdown = join(["# CH Query investigation review", `## ${escape(report.title)}`,
    "### Problem (author assertion)", escape(report.problem || "Not supplied"),
    "### Proposed experiment (author assertion)", escape(report.proposedExperiment || "Not supplied"),
    "Retain the companion investigation JSON to reopen the included evidence. These files have no CH Query link expiry; stored links elsewhere expire after seven days. Compatible readers can open the JSON without a share API. This report remains readable without the site.",
    "### Sharing review", escape(preparation.warning), `Omitted: ${escape(preparation.omissions)}`,
    evidenceMarkdown,
    "CH Query is independent and is not affiliated with or endorsed by ClickHouse, Inc."
  ], true);
  countText(markdown, count => total.add(count));
  const json = `${stableStringify(artifact)}\n`;
  if (new TextEncoder().encode(json).length > INVESTIGATION_LIMITS.totalBytes) throw new RangeError("Reviewed investigation exceeds 20 MiB UTF-8 JSON; omit optional evidence before exporting.");
  countText(json, count => total.add(count));
  return freezeInvestigation({ artifact, report, json, reportJson: `${stableStringify(report, 2)}\n`, markdown, preparation,
    privacy: prepared.preparation.privacy, privacyReview: prepared.privacyReview });
}
