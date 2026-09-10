import { evaluateFindings } from "./findings.js";
import { assessWorkloadIntent, groupFindings, selectCandidateGroups, sortFindings } from "./finding-contract.js";
import { invalidateWorkloadIntent } from "./intent-context.js";
import { buildEvidenceCoverage, buildPlanModel, flattenPlan } from "./model.js";
import { parseEstimate, parseExplainPlan } from "./parser.js";
import { redactBundle } from "./redact.js";
import { prepareMeasurements } from "./investigation-summary.js";

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value) {
  return number(value).toLocaleString("en-US");
}

function formatEstimateCount(value) {
  return Number.isFinite(value) ? formatNumber(value) : "Not reported";
}

function formatPercent(selected, total) {
  return total > 0 ? `${((selected / total) * 100).toFixed(1)}%` : "not available";
}

function markdownValue(value) {
  return String(value ?? "Not reported")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r", "")
    .replaceAll("\n", "<br>");
}

function markdownText(value) {
  return String(value ?? "Not supplied")
    .replace(/[&<>\\`*_{}[\]()#+\-.!|:]/g, character => `&#${character.charCodeAt(0)};`)
    .replaceAll("\r", "")
    .replaceAll("\n", "<br>");
}

function humanizeId(id) {
  return String(id || "finding").replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function findingClaim(finding) {
  return finding.message || finding.claim || humanizeId(finding.id);
}

function findingWhy(finding) {
  if (!finding.why) throw new Error(`Finding ${finding.id || "unknown"} is missing a why explanation`);
  return finding.why;
}

function findingRecommendation(finding) {
  return finding.recommendation || finding.tryFirst || "Review the affected evidence before changing the query or server settings.";
}

function renderFinding(finding, heading = "###") {
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  const table = [
    "| Evidence | Value |",
    "| --- | --- |",
    ...(evidence.length
      ? evidence.map(([label, value]) => `| ${markdownValue(label)} | ${markdownValue(value)} |`)
      : ["| Evidence | Not reported |"])
  ].join("\n");
  const nodeIds = Array.isArray(finding.nodeIds) && finding.nodeIds.length
    ? finding.nodeIds.map(markdownValue).join(", ")
    : "None (bundle-level finding)";

  return [
    `${heading} ${finding.id || "finding"}`,
    `**Severity:** ${finding.severity || "unknown"} · **Confidence:** ${finding.confidence || "unknown"}`,
    `**Claim:** ${findingClaim(finding)}`,
    `**Why:** ${findingWhy(finding)}`,
    ...(finding.classification ? [`**Kind:** ${finding.classification} · **Impact confidence:** ${finding.impactConfidence || "Not a performance claim"}`, `**Priority:** ${finding.priorityReason}`] : []),
    table,
    `**Affected nodes:** ${nodeIds}`,
    `**Try first:** ${findingRecommendation(finding)}`,
    ...(finding.confirmationCheck ? [`**Supporting check:** ${finding.confirmationCheck.supporting}`, `**Weakening check:** ${finding.confirmationCheck.weakening}`, finding.confirmationCheck.limitation] : [])
  ].join("\n\n");
}

function fingerprint(sql) {
  return redactBundle({ sql, explain: {} }).bundle.sql.replace(/\s+/g, " ").trim().slice(0, 80).trimEnd();
}

export function analyzeBundle(bundle, { catalog, concerns } = {}) {
  const parsedPlan = parseExplainPlan(bundle.explain.plan);
  const estimates = parseEstimate(bundle.explain.estimate || []);
  const plan = buildPlanModel(parsedPlan, estimates);
  const nodes = flattenPlan(plan);
  const scans = nodes.filter(node => node["Node Type"] === "ReadFromMergeTree");
  const scanStats = scans.map(node => {
    const index = node.Indexes?.find(item => number(item?.["Initial Granules"]) > 0);
    const selected = number(index?.["Selected Granules"]);
    const total = number(index?.["Initial Granules"]);
    return {
      table: node.table ? `${node.table.database}.${node.table.name}` : node.Description || "Unknown table",
      nodeId: node.nodeId,
      selected,
      total,
      ratio: total > 0 ? selected / total : -1
    };
  });
  const hottest = scanStats.reduce((current, scan) => scan.ratio > (current?.ratio ?? -1) ? scan : current, null);
  const evaluation = evaluateFindings(plan, {
    sql: bundle.sql,
    syntax: bundle.explain.syntax,
    bundle,
    settings: bundle.settings,
    clickhouse: bundle.clickhouse,
    schema: bundle.schema,
    catalog,
    concerns
  });

  return {
    ...evaluation,
    coverage: buildEvidenceCoverage(plan, estimates, bundle),
    summary: {
      fingerprint: fingerprint(bundle.sql),
      nodeCount: nodes.length,
      tablesRead: scans.length,
      tableEstimates: plan.tableEstimates,
      granules: {
        selected: scanStats.reduce((sum, scan) => sum + scan.selected, 0),
        total: scanStats.reduce((sum, scan) => sum + scan.total, 0)
      },
      hottestScan: hottest ? {
        table: hottest.table,
        nodeId: hottest.nodeId,
        selected: hottest.selected,
        total: hottest.total,
        percent: hottest.total > 0 ? Number(((hottest.selected / hottest.total) * 100).toFixed(1)) : null
      } : null
    }
  };
}

export function reportFromBundle(bundle, { link = null, reviewDispositions, catalog, concerns } = {}) {
  const { summary, findings, analysisRevision, coverage, evaluations } = analyzeBundle(bundle, { catalog, concerns });
  const review = reviewDispositions ? findings.filter(item => ["intentional", "not-relevant"].includes(reviewDispositions[item.occurrenceId])).map(item => ({ occurrenceId: item.occurrenceId, ruleId: item.id, disposition: reviewDispositions[item.occurrenceId] })) : null;
  return { version: 1, analysisRevision, summary, coverage, evaluations, findings, link, ...(review ? { review } : {}) };
}

function coverageLabel(coverage) {
  return `Plan: ${coverage.plan.nodeCount} nodes. Scans: ${coverage.scans.label}. Runtime: ${coverage.runtime.available.length} of ${coverage.runtime.total} fields usable (${coverage.runtime.scope.replaceAll("_", " ")} scope). Settings: ${coverage.settings.status === "supplied" ? `${coverage.settings.count} changed settings supplied; coverage is changed-only` : "not supplied"}.`;
}

function briefGap(report) {
  const gaps = [];
  if (report.runtimeDiagnostic) gaps.push(report.runtimeDiagnostic);
  else if (report.measurements?.groups?.length && !report.measurements.selectedGroup) gaps.push(report.measurements.selectionReason);
  else if (!report.coverage.runtime.available.length) gaps.push("No usable runtime measurements; operator timing and repeatability remain unknown.");
  else gaps.push("Query-wide measurements do not establish operator timing or causality.");
  if (report.coverage.scans.status !== "available") gaps.push(report.coverage.scans.label);
  if (!report.coverage.server.version) gaps.push("ClickHouse version was not supplied.");
  return gaps.slice(0, 3);
}

function briefCheck(group) {
  return {
    id: group.ruleId,
    groupId: group.groupId,
    kind: group.classification || "hypothesis",
    checkKind: group.checkKind,
    count: group.count,
    message: group.message,
    why: group.why,
    nextCheck: group.recommendation,
    occurrences: group.occurrences
  };
}

function receiptAttribution(bundle) {
  const attribution = bundle.collection?.receipt?.attribution;
  if (!attribution) return null;
  return {
    namedReads: number(attribution.namedReads),
    anonymousReads: number(attribution.anonymousReads),
    repeatedNamedReads: number(attribution.repeatedNamedReads),
    matchedEstimates: number(attribution.matchedEstimates),
    unmatchedEstimates: number(attribution.unmatchedEstimates),
    limitation: "Receipt counts describe attribution coverage only. Repeated reads are not allocated per plan row, and private source paths are not included."
  };
}

function briefIntents(bundle, current = {}) {
  const assessable = typeof current.evidenceRef === "string" && current.evidenceRef.trim() &&
    typeof current.contractRevision === "string" && current.contractRevision.trim();
  return (bundle.context?.intents || [])
    .map(record => assessable
      ? assessWorkloadIntent(record, { ...current, branchScope: record.branchScope })
      : invalidateWorkloadIntent(record, { evidenceRef: record.evidenceRef,
        reason: "Current owning evidence identity was not supplied; reconfirm intent after reopening or replacement." }))
    .map(intent => ({
      kind: intent.kind,
      statement: intent.statement,
      state: intent.state,
      stateReason: intent.stateReason,
      branchScope: structuredClone(intent.branchScope),
      limitation: intent.limitation
    }));
}

/** The normal agent/CLI result. It is deliberately small and is not importable evidence. */
export function briefFromBundle(bundle, { link = null, name = null, question = null, reviewDispositions = {}, intentEvidence, catalog, concerns } = {}) {
  const analysis = analyzeBundle(bundle, { catalog, concerns });
  const runtime = prepareMeasurements(bundle, analysis.coverage);
  const report = { ...analysis, coverage: runtime.coverage, measurements: runtime.measurements,
    runtimeDiagnostic: runtime.diagnostic, link };
  const checks = selectCandidateGroups(report.findings, reviewDispositions, { limit: 3 }).map(briefCheck);
  const observations = groupFindings(report.findings)
    .filter(group => group.classification === "observation")
    .slice(0, Math.max(1, 3 - checks.length))
    .map(group => `${group.message}${group.count > 1 ? ` (${group.count} occurrences)` : ""}`);
  if (report.summary.granules.total > 0) observations.unshift(
    `Absolute scan scale: ${formatNumber(report.summary.granules.selected)} of ${formatNumber(report.summary.granules.total)} granules selected. Low-urgency structural observation only; not a bottleneck or query-health claim.`
  );
  const gaps = briefGap(report);
  const nextStep = checks[0]?.nextCheck || "Inspect the relevant plan branch; no query change is required by the supplied evidence.";
  const intents = briefIntents(bundle, intentEvidence);
  const attribution = receiptAttribution(bundle);
  return {
    chqueryBrief: 1,
    mode: "understand",
    ...(name || bundle.name ? { name: name || bundle.name } : {}),
    ...(question || bundle.question ? { question: question || bundle.question } : {}),
    coverage: report.coverage,
    observedShape: {
      nodes: report.summary.nodeCount,
      tablesRead: report.summary.tablesRead,
      granules: report.summary.granules,
      observations,
      ...(attribution ? { receiptAttribution: attribution } : {})
    },
    ...(intents.length ? { intents } : {}),
    checks,
    gaps,
    nextStep,
    ...(link ? { link } : {}),
    disclaimer: "No actionable finding is a health certificate. Plan structure alone does not prove runtime, correctness, or improvement."
  };
}

export function briefToMarkdown(brief) {
  const attribution = brief.observedShape.receiptAttribution;
  const intentText = brief.intents?.length ? `\n\n### Scoped workload intent\n\n${brief.intents.map(intent =>
    `- **${markdownText(intent.statement)}** — ${markdownText(intent.state)} at ${markdownText(intent.branchScope.role)} ${markdownText(intent.branchScope.anchor.operator_type)} (${markdownText(intent.branchScope.anchor.path)}). ${markdownText(intent.stateReason)} ${markdownText(intent.limitation)}`).join("\n")}` : "";
  const sections = [
    `# ${brief.name || "Understand this query"}`,
    ...(brief.question ? [`**Question:** ${brief.question}`] : []),
    `## Evidence coverage\n\n${coverageLabel(brief.coverage)}`,
    `## Observed shape\n\n${brief.observedShape.nodes} plan nodes; ${brief.observedShape.tablesRead} table reads; ${formatNumber(brief.observedShape.granules.selected)} of ${formatNumber(brief.observedShape.granules.total)} granules selected.${brief.observedShape.observations.length ? `\n\n${brief.observedShape.observations.map(item => `- ${item}`).join("\n")}` : ""}${attribution ? `\n\n### Receipt attribution\n\nNamed reads: ${attribution.namedReads}; anonymous reads: ${attribution.anonymousReads}; repeated named reads: ${attribution.repeatedNamedReads}; matched estimates: ${attribution.matchedEstimates}; unmatched estimates: ${attribution.unmatchedEstimates}. ${attribution.limitation}` : ""}${intentText}`,
    `## Relevant checks\n\n${brief.checks.length ? brief.checks.map(check => `- **${check.message}** — ${check.why}`).join("\n") : "No actionable checks from supplied evidence. This is not a query health verdict."}`,
    `## Material gaps\n\n${brief.gaps.map(gap => `- ${gap}`).join("\n")}`,
    `## One next step\n\n${brief.nextStep}`
  ];
  if (brief.link) sections.push(`Open this query review: ${brief.link}`);
  sections.push(brief.disclaimer, "CH Query is independent and is not affiliated with or endorsed by ClickHouse, Inc.");
  return `${sections.join("\n\n")}\n`;
}

export function bundleToBriefMarkdown(bundle, options = {}) {
  return briefToMarkdown(briefFromBundle(bundle, options));
}

export function bundleToBriefJson(bundle, options = {}) {
  return JSON.stringify(briefFromBundle(bundle, options));
}

function comparisonCheck(claim) {
  return {
    id: claim.authorClaim?.id || "claim",
    authorClaim: claim.authorClaim || { statement: "Claim not supplied" },
    checkType: claim.checkType || claim.authorClaim?.check_type || "unsupported",
    assessment: claim.assessment,
    evidence: claim.evidence || [],
    missingEvidence: claim.missingEvidence || [],
    reason: claim.reason
  };
}

/** Build the normal comparison output from W3's comparisonBriefInput(report). */
export function briefFromComparison(input, { link = null, name = null, question = null } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Comparison brief input is required.");
  const claims = Array.isArray(input.claims) ? input.claims : [];
  const branches = Array.isArray(input.branches) ? input.branches : [];
  const checks = claims.slice(0, 3).map(comparisonCheck);
  const gaps = [
    ...claims.filter(claim => claim.assessment === "Not assessable").flatMap(claim => claim.missingEvidence || []),
    ...(Array.isArray(input.limitations) ? input.limitations : [])
  ].filter((value, index, list) => typeof value === "string" && value.trim() && list.indexOf(value) === index).slice(0, 3);
  const changedBranches = branches.filter(branch => branch?.status !== "unchanged");
  const missing = checks.find(check => check.assessment === "Not assessable" && check.missingEvidence.length)?.missingEvidence[0];
  const nextStep = missing || (changedBranches.length
    ? "Inspect the first changed branch and its correspondence evidence before accepting a query change."
    : "Confirm the intended review scope; no changed branch is established by the supplied evidence.");
  return {
    chqueryBrief: 1,
    mode: "compare",
    ...(name || input.name ? { name: name || input.name } : {}),
    ...(question || input.question ? { question: question || input.question } : {}),
    labels: input.labels,
    coverage: { fidelity: input.fidelity, correctness: input.correctness },
    observedShape: { changedBranchCount: changedBranches.length, branches: changedBranches.slice(0, 3) },
    checks,
    omittedChecks: Math.max(0, claims.length - checks.length),
    metrics: input.metrics,
    ...(input.hypothesis ? { hypothesis: input.hypothesis } : {}),
    gaps,
    nextStep,
    link,
    disclaimer: "Claims, structural correspondence, measurements and correctness evidence are separate. A plan change does not prove speedup, causality, semantic equivalence or correct results."
  };
}

export function comparisonBriefToMarkdown(brief) {
  const branchText = brief.observedShape.branches.length
    ? brief.observedShape.branches.map(branch => `- ${markdownText(branch.statement || branch.reason || branch.label || branch.status || "Changed branch")}`).join("\n")
    : "No changed branch is established by the supplied evidence.";
  const checkText = brief.checks.length
    ? brief.checks.map(check => `- **${markdownText(check.assessment)} — ${markdownText(check.authorClaim?.statement || "Claim not supplied")}** ${markdownText(check.reason || "No assessment reason supplied.")}`).join("\n")
    : "No author claim was supplied. Review the observed branch changes directly.";
  const sections = [
    `# ${markdownText(brief.name || "Compare a revision")}`,
    ...(brief.question ? [`**Question:** ${markdownText(brief.question)}`] : []),
    `**Roles:** ${markdownText(brief.labels?.baseline || "Baseline")} → ${markdownText(brief.labels?.candidate || "Candidate")}`,
    `## Evidence coverage\n\nCorrectness: ${markdownText(brief.coverage.correctness?.status || "not supplied")}. Fidelity and collection differences limit only the conclusions they affect.`,
    `## Observed branch changes\n\n${branchText}`,
    `## Scoped claim assessments\n\n${checkText}`,
    `## Material gaps\n\n${brief.gaps.length ? brief.gaps.map(gap => `- ${markdownText(gap)}`).join("\n") : "No additional gap was reported. This is not a correctness or performance verdict."}`,
    `## One next step\n\n${markdownText(brief.nextStep)}`
  ];
  if (brief.link) sections.push(`Open this comparison review: ${brief.link}`);
  sections.push(brief.disclaimer, "CH Query is independent and is not affiliated with or endorsed by ClickHouse, Inc.");
  return `${sections.join("\n\n")}\n`;
}

export function comparisonBriefToJson(brief) {
  return JSON.stringify(brief);
}

export function reportToMarkdown(report) {
  const { summary } = report;
  const queryFindings = sortFindings(report.findings).filter(finding => finding.classification !== "observation");
  const observations = sortFindings(report.findings).filter(finding => finding.classification === "observation");
  const sections = [
    `# CH Query report — ${summary.fingerprint}`,
    "## Summary",
    [
      `- **Plan nodes:** ${formatNumber(summary.nodeCount)}`,
      `- **Tables read:** ${formatNumber(summary.tablesRead)}`,
      `- **Granules:** ${formatNumber(summary.granules.selected)} selected / ${formatNumber(summary.granules.total)} total (${formatPercent(summary.granules.selected, summary.granules.total)})`,
      `- **Hottest scan:** ${summary.hottestScan ? `${summary.hottestScan.table} — ${formatNumber(summary.hottestScan.selected)} / ${formatNumber(summary.hottestScan.total)} granules (${summary.hottestScan.percent ?? "not available"}${summary.hottestScan.percent === null ? "" : "%"})` : "Not available"}`
    ].join("\n")
  ];

  if (report.coverage) sections.push(`## Evidence coverage\n\n${report.coverage.scans.label}. Runtime: ${report.coverage.runtime.available.length} of ${report.coverage.runtime.total} query-wide fields. ${report.coverage.runtime.limitation}`);

  if (summary.tableEstimates?.length) {
    sections.push([
      "## Table scan estimates",
      "",
      "EXPLAIN ESTIMATE totals are table-wide scan evidence, not operator output rows or execution time.",
      "",
      "| Table | Estimated rows | Parts | Marks | Read occurrences | Attribution |",
      "| --- | --- | --- | --- | --- | --- |",
      ...summary.tableEstimates.map(estimate => `| ${markdownValue(estimate.table)} | ${formatEstimateCount(estimate.rows)} | ${formatEstimateCount(estimate.parts)} | ${formatEstimateCount(estimate.marks)} | ${estimate.readCount} | ${estimate.allocation === "ambiguous" ? "Per-read split unknown; do not sum this total once per read" : "Single read"} |`)
    ].join("\n"));
  }

  if (queryFindings.length) {
    sections.push("## Findings");
    sections.push(queryFindings.map(finding => renderFinding(finding, "####")).join("\n\n"));
  } else {
    sections.push("## Findings\n\nNo actionable findings from supplied evidence. This is not a query health verdict.");
  }

  if (observations.length) sections.push(`## Observations\n\n${observations.map(finding => renderFinding(finding, "####")).join("\n\n")}`);
  if (report.review) {
    sections.push(`## Current investigation review\n\nUser judgments, not analyzer conclusions or proof of a fix. All original findings remain above.\n\n${report.review.length ? report.review.map(item => `- ${markdownValue(item.ruleId)} (${markdownValue(item.occurrenceId)}): ${item.disposition}`).join("\n") : "No reviewed findings."}`);
  }

  const footer = [];
  if (report.link) footer.push(`View this analysis in CH Query: ${report.link}`);
  footer.push("CH Query is independent and is not affiliated with or endorsed by ClickHouse, Inc.");
  sections.push(footer.join("\n\n"));
  return `${sections.join("\n\n")}\n`;
}

export function bundleToMarkdown(bundle, options = {}) {
  return reportToMarkdown(reportFromBundle(bundle, options));
}

export function bundleToJson(bundle, options = {}) {
  return JSON.stringify(reportFromBundle(bundle, options), null, 2);
}

export function findingsToMarkdown(findings) {
  if (findings.length === 0) return "# CH Query findings\n\nNo actionable findings from supplied evidence.\n";
  return `# CH Query findings\n\n${sortFindings(findings).map(finding => renderFinding(finding, "##")).join("\n\n")}\n`;
}
