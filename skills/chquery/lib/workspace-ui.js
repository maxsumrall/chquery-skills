import {
  evaluateFindings,
  configureSettingsKnowledge,
  getNodeSuggestion,
} from "./findings.js";
import {
  createInvestigationReview,
  groupFindings,
  selectCandidates,
} from "./finding-contract.js";
import { bundleFromWizard, wizardFromBundle } from "./bundle.js";
import {
  collectionSQL,
  metadataSQL,
  planInput,
  rowInput,
  runtimeInput,
  runtimeSQL,
  mergeManualRuntime,
  withoutQueryEvidence,
  copyCollectionText,
} from "./collection.js";
import {
  buildCostModel,
  buildEvidenceCoverage,
  buildIndexReads,
  buildPlanModel,
  computePlanStats,
} from "./model.js";
import { investigationSummary } from "./investigation-summary.js";
import { RUNTIME_COLLECTION_PROMPT } from "./agent-contract.js";
import { parseEstimate, parseExplainPlan } from "./parser.js";
import { parsePipeline } from "./pipeline.js";
import { parseAnalyze, attachAnalyze } from './analyze.js';
import { summarizeStage, isPreparation, getStageEvidence, getMapCheckLabel, findingObservation } from "./query-map.js";
import { briefFromBundle } from "./report.js";
import { createLineageView } from "./lineage-ui.js";
let settingsData;
function loadSettingsData() {
  settingsData ||= Promise.all([
    fetch("./data/settings-catalog.json").then((response) => response.json()),
    fetch("./data/settings-concerns.json").then((response) => response.json()),
  ]).then(([catalog, concerns]) => {
    configureSettingsKnowledge(catalog, concerns);
    return [catalog, concerns];
  });
  return settingsData;
}

function bundleNeedsSettingsData(bundle) {
  return Boolean(
    bundle?.clickhouse?.version || bundle?.settings?.changed?.length,
  );
}
export function initWorkspaceUI() {
  "use strict";

  // --- Helper Functions ---

  // Use a canvas for efficient text measurement.
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  let detailedMap = false;

  function fitCardText(text, width) {
    if (context.measureText(text).width <= width) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (context.measureText(text.slice(0, mid) + '…').width <= width) low = mid;
      else high = mid - 1;
    }
    return text.slice(0, low) + '…';
  }

  function getNodeDimensions(node) {
    node.summary = summarizeStage(
      (node.grouped || [node]).map((member) => member.data),
    );
    if (
      !node.planParent &&
      node.summary.kind === "transform" &&
      (node.grouped || [node]).every((member) => isPreparation(member.data))
    )
      node.summary = {
        ...node.summary,
        kind: "result",
        title: "Deliver result",
      };
    context.font = `${node.summary.kind === "source" ? 600 : 500} 17px ${getComputedStyle(document.body).getPropertyValue("--font-ui")}`;
    const headline = node.summary.title;
    const width = 260;
    const lines = [];
    let remaining = headline;
    while (remaining && lines.length < 1) {
      let end = remaining.length;
      while (
        end > 1 &&
        context.measureText(
          remaining.slice(0, end) + (end < remaining.length ? "…" : ""),
        ).width >
          width - 80
      )
        end--;
      const wordBreak = Math.max(
        remaining.lastIndexOf(" ", end),
        remaining.lastIndexOf("_", end),
      );
      if (lines.length === 0 && end < remaining.length && wordBreak > end / 2)
        end = wordBreak + 1;
      lines.push(
        remaining.slice(0, end) +
          (end < remaining.length ? "…" : ""),
      );
      remaining = remaining.slice(end);
    }
    node.cardLines = lines;
    const members = (node.grouped || [node]).map(member => member.data);
    node.evidence = getStageEvidence(members);
    const related = (window.currentAnalysis?.issues || []).filter(issue =>
      members.some(member => issue.nodeIds?.includes(member.nodeId)));
    const candidate = selectCandidates(related, review.snapshot())[0];
    node.candidate = candidate;
    node.cue = candidate ? getMapCheckLabel(candidate) : null;
    node.evidenceTop = 58;
    const sourceEvidence = node.evidence.filter(line => /scan rows|estimate|granules kept/i.test(line));
    node.visibleEvidence = (node.summary.kind === 'source' ? sourceEvidence : node.evidence)
      .filter(line => line !== 'Operator details not supplied')
      .slice(0, detailedMap ? 4 : node.summary.kind === 'source' ? 2 : 1)
      .map(line => line.replace(/^Plan: /, '').replace(/^Est\. scan rows: /, 'Est. rows: ').replace(/^(.+): (.+) granules kept$/, 'Granules: $2'));
    if (node.summary.kind === 'source' && node.visibleEvidence.length < 2)
      node.visibleEvidence.push('Granules: not supplied');
    node.cardHeight = detailedMap ? 160 : node.summary.kind === 'source' ? 126 : 108;
    return {
      width,
      height:
        node.cardHeight +
        (expandedChains.has(node.data.nodeId) && node.grouped
          ? node.grouped.length * 34 + 12
          : 0),
    };
  }

  function truncate(value, maxLength) {
    if (!value || value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 3)}...`;
  }

  function getNodeHeadline(data) {
    if (data.table) return `${data.table.database}.${data.table.name}`;
    return data.Description || data["Node Type"] || "Unknown";
  }

  function getNodeCardKind(data) {
    return data["Node Type"] === "ReadFromMergeTree"
      ? "Read MergeTree"
      : data["Node Type"] || "Unknown";
  }

  function scanEvidence(data) {
    if (Number.isFinite(data.ownRows))
      return `Est. scan rows: ${formatNumber(data.ownRows)}`;
    if (Number.isFinite(data.flowRows))
      return `Upstream scan est.: ${formatNumber(data.flowRows)}`;
    if (data.hasAmbiguousEstimate) return "Per-read estimate unknown";
    return "Scan estimate unavailable";
  }

  // --- D3 Setup ---
  const container = d3.select("#treeContainer");
  let width = container.node().clientWidth;
  let height = container.node().clientHeight || 700;

  // Create SVG
  const svg = container
    .append("svg")
    .attr("width", "100%")
    .attr("height", height)
    .attr("viewBox", [0, 0, width, height]);

  // Add zoom behavior
  const zoom = d3
    .zoom()
    .scaleExtent([0.001, 3])
    .on("zoom", (event) => {
      if (event.sourceEvent) fitted = false;
      g.attr("transform", event.transform);
      document.getElementById("graphZoom").textContent =
        `${Math.round(event.transform.k * 100)}%`;
      updateMinimapViewport(event.transform);
    });

  svg.call(zoom);
  svg.on('dblclick.zoom', null);

  // Create a group for the graph
  const g = svg.append("g");
  let currentLayout = null;
  let currentRoot = null;
  let currentFitTransform = d3.zoomIdentity;
  let allNodes = [];
  const personalReview = createInvestigationReview();
  const demoReview = createInvestigationReview();
  let review = personalReview;
  let inspectedNode = null;
  let includeReviewReport = false;
  let personalReportOption = false;
  let preferredInvestigation = null;
  let personalMeasurementGroup;
  let summaryReturnTarget = null;
  let renderedBrief = null;
  const groupUndo = new Map();
  const expandedChains = new Set();
  let fitted = true;
  const workspace = document.querySelector(".workspace-shell");
  const mapToolbar = document.querySelector('.tab-bar');
  const mapFrameObserver = new ResizeObserver(() => {
    workspace.style.setProperty('--map-header-height', `${document.querySelector('.site-header').offsetHeight}px`);
    workspace.style.setProperty('--map-toolbar-height', `${mapToolbar.offsetHeight}px`);
  });
  mapFrameObserver.observe(document.querySelector('.site-header'));
  mapFrameObserver.observe(mapToolbar);
  let roleSelectionResolve = null;

  function finishRoleSelection(result) {
    if (!roleSelectionResolve) return;
    const resolve = roleSelectionResolve;
    roleSelectionResolve = null;
    document.getElementById("roleSelectionDialog").close();
    resolve(result);
  }

  function selectComparisonRoles(sources) {
    if (
      !Array.isArray(sources) ||
      sources.length < 2 ||
      sources.length > 20 ||
      sources.some(
        (source) => !source?.bundle || typeof source.name !== "string",
      )
    ) {
      throw new TypeError(
        "Role selection requires between 2 and 20 named standalone analysis files.",
      );
    }
    if (roleSelectionResolve)
      throw new Error("Finish the current role selection first.");
    const container = document.getElementById("roleSelectionSources");
    container.replaceChildren(
      ...sources.map((source, index) => {
        const row = document.createElement("label");
        row.dataset.roleSource = String(index);
        const name = document.createElement("span");
        name.textContent = source.name;
        const select = document.createElement("select");
        select.dataset.roleSelection = String(index);
        select.setAttribute("aria-label", `Role for ${source.name}`);
        for (const [value, label] of [
          ["ignore", "Do not compare"],
          ["baseline", "Baseline"],
          ["candidate", "Candidate"],
        ])
          select.add(new Option(label, value));
        row.append(name, select);
        return row;
      }),
    );
    const error = document.getElementById("roleSelectionError");
    error.hidden = true;
    error.textContent = "";
    document.getElementById("roleSelectionDialog").showModal();
    container.querySelector("select")?.focus();
    return new Promise((resolve) => {
      roleSelectionResolve = resolve;
    });
  }

  document
    .getElementById("confirmRoleSelection")
    .addEventListener("click", () => {
      const selections = [
        ...document.querySelectorAll("[data-role-selection]"),
      ];
      const selected = Object.fromEntries(
        ["baseline", "candidate"].map((role) => [
          role,
          selections.filter((input) => input.value === role),
        ]),
      );
      if (selected.baseline.length !== 1 || selected.candidate.length !== 1) {
        const error = document.getElementById("roleSelectionError");
        error.hidden = false;
        error.textContent =
          "Choose exactly one baseline and one candidate. No role was inferred.";
        selections.forEach((input) =>
          input.setAttribute(
            "aria-invalid",
            String(
              input.value !== "ignore" && selected[input.value]?.length !== 1,
            ),
          ),
        );
        return;
      }
      finishRoleSelection(
        Object.fromEntries(
          Object.entries(selected).map(([role, [input]]) => [
            role,
            Number(input.dataset.roleSelection),
          ]),
        ),
      );
    });
  document
    .getElementById("cancelRoleSelection")
    .addEventListener("click", () => finishRoleSelection(null));
  document
    .getElementById("roleSelectionDialog")
    .addEventListener("cancel", (event) => {
      event.preventDefault();
      finishRoleSelection(null);
    });

  function setRail(name, open) {
    document.getElementById(`${name}Rail`).hidden = !open;
    workspace.classList.toggle(`hide-${name}`, !open);
    document
      .getElementById(`toggle${name[0].toUpperCase()}${name.slice(1)}`)
      .setAttribute("aria-expanded", String(open));
  }
  for (const name of ["evidence", "inspector"]) {
    document
      .getElementById(`toggle${name[0].toUpperCase()}${name.slice(1)}`)
      .addEventListener("click", () => {
        setRail(name, document.getElementById(`${name}Rail`).hidden);
      });
  }

  // Initialize flextree layout
  const flextree = d3
    .flextree()
    .nodeSize((d) => {
      const dimensions = d.data.dimensions || { width: 180, height: 40 };
      return [dimensions.height + 32, dimensions.width + 80];
    })
    .spacing(() => 20);

  function formatNumber(value) {
    if (value === null || value === undefined) return "—";
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString() : "n/a";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function observationText(issue) {
    return findingObservation(issue, allNodes.find(node => issue.nodeIds.includes(node.data.nodeId))?.data);
  }

  function emptyView(title, command) {
    return `<div class="view-empty"><h3>${escapeHtml(title)}</h3><p>Run this optional query in ClickHouse, replacing &lt;query&gt; with your SQL. Ask your agent to add the output to the bundle, then reimport it.</p><p><code>${escapeHtml(command)}</code></p><button class="compact-button copy-command" type="button" data-command="${escapeHtml(command)}">Copy template</button></div>`;
  }

  function evidenceBadge(kind) {
    return `<span class="evidence-badge ${kind}">${kind}</span>`;
  }

  function prepareRuntime(bundle, coverage, options = {}) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./measurement-worker.js", import.meta.url),
        { type: "module" },
      );
      worker.onmessage = ({ data }) => {
        worker.terminate();
        resolve(data);
      };
      worker.onerror = () => {
        worker.terminate();
        reject(
          new Error("Could not prepare runtime evidence. Retry the import."),
        );
      };
      worker.postMessage({ bundle, coverage, options });
    });
  }

  function focusEvidence(element) {
    if (!element) return;
    if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "start", behavior: "instant" });
  }

  // These controls belong to the result, but share the existing header actions.
  const shareStatus = document.getElementById('shareStatus');
  const mobileHeader = matchMedia('(max-width: 600px)');
  const shareMenu = document.querySelector('.share-menu');
  const headerControls = ['serverChip', 'openStoredShare'].map(id => document.getElementById(id));
  function arrangeHeader() {
    if (mobileHeader.matches) shareMenu.querySelector('.share-menu-items').prepend(...headerControls);
    else shareMenu.before(...headerControls);
  }
  mobileHeader.addEventListener('change', arrangeHeader);
  arrangeHeader();
  const reportOption = document.createElement("label");
  reportOption.className = "review-report-option";
  reportOption.innerHTML = '<input id="includeReviewReport" type="checkbox"> Include current review judgments when copying a report (opt-in)';
  document.getElementById("copyMarkdownReportButton").after(reportOption);
  document.addEventListener("click", event => {
    if (event.target.closest("[data-map-help]")) document.getElementById("mapHelp").showModal();
    if (event.target.closest("[data-close-map-help]")) document.getElementById("mapHelp").close();
  });

  function renderAnalysisSummary(analysis) {
    const section = document.getElementById("analysisSummary");
    section.hidden = activeDemo || document.body.dataset.page !== "results";
    if (section.hidden) return;
    const summary = investigationSummary(analysis, preferredInvestigation);
    const { candidate, action } = summary;
    const brief = analysis.brief || briefFromBundle(wizardState.bundle);
    renderedBrief = structuredClone(brief);
    document.getElementById("analysisSummaryTitle").textContent =
      "Query";
    section.querySelector("[data-summary-findings]").textContent =
      "Worth a look";
    document.getElementById("summaryPrimaryActions").innerHTML =
      `<button type="button" class="compact-button summary-primary" data-summary-action="${candidate?.nodeIds.length ? "inspect" : action.kind}">${candidate?.nodeIds.length ? "Inspect evidence" : action.label}</button>`;
    section.querySelector("[data-agent-handoff]").hidden = !candidate;
    const coverage = analysis.coverage;
    const attribution = brief.observedShape.receiptAttribution;
    const intents = brief.intents || [];
    const summaryLinks = section.querySelector('.summary-links');
    const query = wizardState.bundle.sql?.replace(/\s+/g, ' ').trim() || 'Query plan';
    document.getElementById("summaryContent").innerHTML = `
      <p class="summary-claim" title="${escapeHtml(query)}">${escapeHtml(query)}</p>
      <p class="summary-coverage-line">Plan parsed · Estimates: ${escapeHtml(coverage.scans.status)} · Runtime: ${coverage.runtime.available.length ? escapeHtml(summary.runtimeLabel) : "none"} · Server: ${escapeHtml(coverage.server.version || "unknown")} · Settings: ${escapeHtml(coverage.settings.status)}</p>
      <details class="summary-coverage"><summary>Missing context</summary>
      <p>${escapeHtml(brief.name)}</p>
      ${brief.question ? `<p class="summary-question" data-brief-question><b>Question:</b> ${escapeHtml(brief.question)}</p>` : ""}
      <div class="summary-grid">
        <div><h3>What the evidence shows</h3><p>${brief.observedShape.granules.selected.toLocaleString()} of ${brief.observedShape.granules.total.toLocaleString()} granules selected</p><ul class="summary-observations">${brief.observedShape.observations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>${attribution ? `<div class="receipt-attribution" data-receipt-attribution><h4>Receipt attribution</h4><p>Named reads: ${attribution.namedReads} · Anonymous reads: ${attribution.anonymousReads} · Repeated named reads: ${attribution.repeatedNamedReads} · Matched estimates: ${attribution.matchedEstimates} · Unmatched estimates: ${attribution.unmatchedEstimates}</p><p>${escapeHtml(attribution.limitation)}</p></div>` : ""}${intents.length ? `<div class="scoped-intents" data-brief-intents><h4>Scoped workload intent</h4>${intents.map((intent) => `<p><b>${escapeHtml(intent.statement)}</b><br>${escapeHtml(intent.state)} · ${escapeHtml(intent.branchScope.role)} ${escapeHtml(intent.branchScope.anchor.operator_type)} · <code>${escapeHtml(intent.branchScope.anchor.path)}</code><br>${escapeHtml(intent.stateReason)} ${escapeHtml(intent.limitation)}</p>`).join("")}</div>` : ""}</div>
        <div><h3>What remains unknown</h3><ul class="brief-gaps">${brief.gaps.map((gap) => `<li data-brief-gap>${escapeHtml(gap)}</li>`).join("")}</ul><h4>One next step</h4><p data-brief-next-step>${escapeHtml(brief.nextStep)}</p></div>
      </div>
      <h3>Evidence coverage</h3>
        <dl><dt>Plan</dt><dd>${coverage.plan.nodeCount} parsed steps</dd><dt>Scan estimates</dt><dd>${escapeHtml(coverage.scans.label)}${coverage.scans.ambiguousTables.length ? " · per-read split unknown" : ""}${coverage.scans.unmatched.length ? `<p>Unmatched tables: ${escapeHtml(coverage.scans.unmatched.join(", "))}</p>` : ""}</dd><dt>Runtime</dt><dd>${escapeHtml(summary.runtimeLabel)} · ${escapeHtml(summary.scopeLabel)}. ${escapeHtml(coverage.runtime.limitation)}${coverage.runtime.missing.length ? `<p>Unavailable in the selected evidence: ${escapeHtml(coverage.runtime.missing.join(", "))}.</p>` : ""}${analysis.diagnostic ? `<p>${escapeHtml(analysis.diagnostic)}</p>` : ""}<button class="text-button" type="button" data-summary-runtime>Review runtime in Costs</button></dd><dt>Server</dt><dd>Version: ${escapeHtml(coverage.server.version || "not supplied")} · deployment: ${coverage.server.cloudMode === 1 ? "Cloud" : coverage.server.cloudMode === 0 ? "self-hosted" : "unknown"}</dd><dt>Changed settings</dt><dd>${coverage.settings.status === "supplied" ? `${coverage.settings.count} supplied · changed-only coverage` : "Not supplied"}</dd><dt>Optional context</dt><dd>${Object.entries(
          coverage.optional,
        )
          .map(
            ([name, supplied]) =>
              `${escapeHtml(name)}: ${supplied ? "supplied" : "not supplied"}`,
          )
          .join(" · ")}</dd></dl>
        <p>${escapeHtml(brief.disclaimer)}</p><button type="button" class="text-button" data-summary-evidence>Open evidence rail</button>
      </details>`;
    section.querySelector('.summary-coverage > summary').after(shareStatus);
    (document.getElementById('summaryContent').hidden ? section : section.querySelector('.summary-coverage')).append(summaryLinks);
    const chips = document.createElement('div');
    chips.className = 'finding-chips';
    chips.innerHTML = `<span>Worth a look</span>${analysis.issues.map(issue => `<button type="button" class="compact-button" data-node-id="${escapeHtml(issue.nodeIds[0] || '')}">${escapeHtml(observationText(issue))}</button>`).join('')}`;
    document.getElementById('summaryContent').append(chips);
    document.getElementById("summaryStatus").textContent =
      `${analysis.candidates.length} possible check${analysis.candidates.length === 1 ? "" : "s"}, not confirmed problems. Runtime ${summary.runtimeLabel}.`;
  }

  document
    .getElementById("toggleSummary")
    .addEventListener("click", (event) => {
      const content = document.getElementById("summaryContent");
      content.hidden = !content.hidden;
      const section = document.getElementById('analysisSummary');
      (content.hidden ? section : section.querySelector('.summary-coverage')).append(section.querySelector('.summary-links'));
      event.currentTarget.setAttribute(
        "aria-expanded",
        String(!content.hidden),
      );
      event.currentTarget.textContent = content.hidden
        ? "Expand summary"
        : "Collapse summary";
      event.currentTarget.focus({ preventScroll: true });
    });
  document.addEventListener("click", (event) => {
    const button = event.target.closest(
      "[data-summary-action], [data-summary-map], [data-summary-findings], [data-summary-choose], [data-summary-runtime], [data-summary-evidence], [data-investigate], [data-agent-handoff], [data-back-summary]",
    );
    if (!button || activeDemo || document.body.dataset.page !== "results")
      return;
    const analysis = window.currentAnalysis;
    if (button.hasAttribute("data-back-summary")) {
      focusEvidence(
        summaryReturnTarget?.isConnected
          ? summaryReturnTarget
          : document.getElementById("analysisSummaryTitle"),
      );
      return;
    }
    if (button.hasAttribute("data-investigate")) {
      preferredInvestigation = button.dataset.investigate;
      renderAnalysisSummary(analysis);
      document.getElementById("summaryContent").hidden = false;
      document
        .getElementById("toggleSummary")
        .setAttribute("aria-expanded", "true");
      document.getElementById("toggleSummary").textContent = "Collapse summary";
      focusEvidence(document.getElementById("analysisSummaryTitle"));
      return;
    }
    if (button.hasAttribute("data-agent-handoff")) {
      const candidate = investigationSummary(
        analysis,
        preferredInvestigation,
      ).candidate;
      const dispositions = review.snapshot();
      const reviewJudgments = analysis.issues
        .filter((item) => dispositions[item.occurrenceId])
        .map((item) => ({
          message: item.message,
          status: dispositions[item.occurrenceId],
        }));
      window.chqueryAgentHandoff.open(
        {
          bundle: wizardState.bundle,
          finding: candidate,
          coverage: analysis.coverage,
          reviewJudgments,
        },
        button,
      );
      return;
    }
    summaryReturnTarget = button;
    const action = button.dataset.summaryAction;
    const candidate = investigationSummary(
      analysis,
      preferredInvestigation,
    ).candidate;
    if (action === "inspect") window.highlightNodes(candidate.nodeIds);
    else if (
      action === "runtime" ||
      button.hasAttribute("data-summary-runtime")
    ) {
      showView("costs");
      focusEvidence(document.getElementById("runtimeEvidenceTitle"));
    } else if (
      action === "finding" ||
      button.hasAttribute("data-summary-findings") ||
      button.hasAttribute("data-summary-choose")
    ) {
      const card =
        action === "finding" &&
        [...document.querySelectorAll(".finding-card")].find(
          (item) => item.dataset.occurrence === candidate.occurrenceId,
        );
      focusEvidence(card || document.querySelector("#findings h2"));
    } else if (button.hasAttribute("data-summary-evidence")) {
      setRail("evidence", true);
      focusEvidence(document.getElementById("evidenceRail"));
    } else {
      showView("river");
      focusEvidence(document.getElementById("fitGraphButton"));
    }
  });

  function renderEvidenceViews(plan, analysis) {
    const bundle = wizardState.bundle || {};
    const pipelinePanel = document.querySelector('[data-panel="pipelines"]');
    const costsPanel = document.querySelector('[data-panel="costs"]');
    const indexesPanel = document.querySelector('[data-panel="indexes"]');
    try {
      const pipeline = bundle.explain?.pipeline;
      if (!pipeline?.trim()) {
        pipelinePanel.innerHTML = emptyView(
          "No EXPLAIN PIPELINE in this bundle",
          "EXPLAIN PIPELINE <query>",
        );
      } else {
        const stages = parsePipeline(pipeline, plan).stages;
        pipelinePanel.innerHTML = `<div class="view-heading"><div><span class="section-label">Execution processors</span><h3>${stages.length} pipeline stages</h3></div><p>Threads and fan-in are direct evidence from EXPLAIN PIPELINE.</p></div><ol class="pipeline-list">${stages
          .map(
            (stage, index) => `
          <li class="pipeline-stage ${stage.blocking ? "blocking" : ""}" data-plan-node="${stage.planNode || ""}">
            <span class="stage-order">${String(index + 1).padStart(2, "0")}</span><i aria-hidden="true"></i>
            <div><span class="stage-plan">${escapeHtml(stage.name)}</span><strong>${escapeHtml(stage.processor)}</strong>${stage.planNode ? `<button type="button" class="plan-node-link" data-node-id="${stage.planNode}">Plan step ${escapeHtml(stage.planNode)} →</button>` : ""}</div>
            <div class="stage-flow"><b>${stage.threads}</b><span>threads</span>${stage.inputs === null ? "" : `<small>${stage.inputs} → ${stage.outputs}</small>`}</div>
          </li>`,
          )
          .join("")}</ol>`;
      }
    } catch (error) {
      pipelinePanel.innerHTML = emptyView(
        `Could not parse EXPLAIN PIPELINE: ${error.message}`,
        "EXPLAIN PIPELINE <query>",
      );
    }

    const costs = buildCostModel(plan, bundle.runtime);
    const metrics = analysis.coverage.runtime.metrics;
    const knownMetrics = metrics.filter((metric) => metric.value !== null);
    const missingMetrics = metrics.filter((metric) => metric.value === null);
    const measurements = analysis.measurements;
    const runtimeScope = investigationSummary(analysis).scopeLabel;
    const runtimePrompt = RUNTIME_COLLECTION_PROMPT;
    const runtimeEvidence = `<h3 id="runtimeEvidenceTitle" tabindex="-1">Runtime evidence</h3><p class="metric-note">${escapeHtml(runtimeScope)}. These values do not measure individual operators.</p>
      ${analysis.diagnostic ? `<p class="runtime-invalid">${escapeHtml(analysis.diagnostic)} The plan remains available; runtime stays unknown.</p>` : ""}
      ${
        measurements
          ? `<p class="runtime-selection-note">${escapeHtml(measurements.selectionReason)}</p>${measurements.groups.length && measurements.source === "samples" ? `<label class="runtime-group-label">Observation group<select id="runtimeGroup"><option value="">Choose a group (do not combine protocols)</option>${measurements.groups.map((group, index) => `<option value="${index}" ${group.key === measurements.selectedGroup ? "selected" : ""}>Group ${index + 1} · ${group.count} observations · ${escapeHtml(group.provenance.scope || "unknown scope")} · ${escapeHtml(group.provenance.cache || "unknown cache")}</option>`).join("")}</select></label>` : ""}${measurements.source === "samples" ? `<p>Explicit samples are authoritative; legacy query_log is not used. Values below are medians of the selected observations, not repeatability claims.</p>` : ""}<details class="runtime-sample-details"><summary>Measurement details (${measurements.samples.length} observations)</summary>${
              measurements.samples
                .map(
                  (sample) =>
                    `<p>Observation ${sample.index + 1}: ${sample.excluded ? `excluded · ${escapeHtml(sample.exclusionReasons.join(" "))}` : "eligible"}${sample.provenance.diagnostics.length ? ` · ${escapeHtml(sample.provenance.diagnostics.join(" "))}` : ""}${Object.entries(
                      sample.metrics,
                    )
                      .filter(([, metric]) => metric.state === "invalid")
                      .map(
                        ([name, metric]) =>
                          ` · ${escapeHtml(name)}: invalid (${escapeHtml(metric.reason)})`,
                      )
                      .join("")}</p>`,
                )
                .join("") || "<p>No observations supplied.</p>"
            }</details>`
          : ""
      }
      ${
        knownMetrics.length
          ? `<div class="runtime-metrics">${knownMetrics
              .map((metric) => {
                const stats = measurements?.summaries[metric.name];
                return `<div><span>${escapeHtml(metric.name.replaceAll("_", " "))}</span><b>${formatNumber(metric.value)}</b><small>${metric.name === "query_duration_ms" ? "ms" : ["read_bytes", "memory_usage"].includes(metric.name) ? "bytes" : "rows"}</small>${evidenceBadge(metric.evidence)}${measurements?.source === "samples" ? `<small>${stats.valid}/${stats.selected} usable · range ${formatNumber(stats.min)}–${formatNumber(stats.max)}</small>` : ""}</div>`;
              })
              .join("")}</div>`
          : ""
      }
      ${
        metrics.some((metric) => metric.state === "invalid")
          ? `<p class="runtime-invalid">Invalid measurements (not treated as zero): ${metrics
              .filter((metric) => metric.state === "invalid")
              .map((metric) => escapeHtml(metric.name))
              .join(
                ", ",
              )}. Supply finite nonnegative numeric values within safe integer magnitude.</p>`
          : ""
      }
      ${missingMetrics.length && !Object.hasOwn(bundle.runtime || {}, "samples") ? `<section class="runtime-guidance" aria-labelledby="runtimeGuidanceTitle"><span class="section-label">${knownMetrics.length ? "Partial runtime evidence" : "Plan available · runtime not supplied"}</span><h3 id="runtimeGuidanceTitle">${knownMetrics.length ? "Add the remaining measurements" : "Add a measured run"}</h3><p>Use an already-authorized run of this SQL to add rows, bytes, memory and duration, with its actual scope. These measurements do not identify time spent in individual operators.</p>${knownMetrics.length ? `<p class="runtime-missing">Not supplied: ${missingMetrics.map((metric) => escapeHtml(metric.name)).join(", ")}.</p>` : ""}<button class="compact-button copy-command" type="button" data-command="${escapeHtml(runtimePrompt)}">Copy runtime collection prompt</button><p class="runtime-privacy">The app does not connect to your database. Give the prompt and bundle to your agent, review the result, then reimport it.</p></section>` : ""}
      ${Object.hasOwn(bundle.runtime || {}, "samples") ? '<p class="runtime-privacy">To change authoritative samples, review the bundle with your collector and reimport it. The single-run editor cannot replace samples. No collection or execution is required to continue exploring.</p><button class="text-button" type="button" data-open-runtime>Why is the single-run editor unavailable?</button>' : `<div class="runtime-manual-action"><button class="compact-button" type="button" data-open-runtime>Collect runtime manually</button><p>Optional. Paste metrics from your SQL client without editing a bundle. Saving replaces the previous run; missing values stay unknown.</p>${bundle.runtime?.provenance?.association === "user_attested" ? "<p>User confirmed the run association; CH Query has not independently verified it.</p>" : ""}</div>`}`;
    const hasCosts = analysis.coverage.scans.supplied > 0;
    if (!hasCosts) {
      costsPanel.innerHTML =
        runtimeEvidence +
        emptyView(
          "No scan estimates in this bundle",
          "EXPLAIN ESTIMATE <query> FORMAT JSONEachRow",
        );
    } else {
      const maxRows = Math.max(1, ...costs.rows.map((row) => row.rows || 0));
      costsPanel.innerHTML = `<div class="view-heading"><div><span class="section-label">Scan estimates & runtime</span><h3>Costs by plan step</h3></div><p>${escapeHtml(analysis.coverage.scans.label)}. EXPLAIN ESTIMATE supplies table-wide scan estimates, not operator output rows or time. Upstream sums appear only when every input has attributable scan rows. Runtime scope follows supplied provenance below.</p></div>
        ${runtimeEvidence}
        ${costs.tableEstimates?.length ? `<section class="table-estimates" aria-label="Table-wide estimates"><div class="view-heading"><div><span class="section-label">Counted once per table</span><h3>Table-wide estimates</h3></div><p>A table-wide estimate cannot be assigned to individual repeated reads. Their per-read split remains unknown.</p></div><div class="index-list">${costs.tableEstimates.map((estimate) => `<article class="index-card"><header><div><h3>${escapeHtml(estimate.table)}</h3><p>${estimate.readCount} plan read${estimate.readCount === 1 ? "" : "s"} · ${estimate.allocation === "ambiguous" ? "Table-wide estimate · per-read split unknown" : "Single-read estimate"}</p></div></header><dl>${["rows", "parts", "marks"].map((name) => `<div><dt>${name}</dt><dd>${estimate[name] === null ? "—" : formatNumber(estimate[name])}</dd></div>`).join("")}</dl></article>`).join("")}</div></section>` : ""}
        <div class="cost-table" role="table"><div class="cost-row cost-header" role="row"><span>Plan step</span><span>Scan rows</span><span>Evidence</span></div>${costs.rows.map((row) => `<button class="cost-row" role="row" type="button" data-node-id="${row.nodeId}"><span><i class="heat-bar heat-${row.heatLevel}" style="--row-width:${row.rows === null ? 0 : Math.max(2, (row.rows / maxRows) * 100)}%"></i><b>${escapeHtml(row.name)}</b><small>${escapeHtml(row.table || "upstream scans")}</small></span><span>${row.rows === null ? "—" : formatNumber(row.rows)}</span><span class="evidence-badge ${row.evidence}">${row.evidence === "known" ? "estimate" : row.evidence === "inferred" ? "upstream sum" : row.evidence === "ambiguous" ? "allocation unknown" : "missing"}</span></button>`).join("")}</div>`;
    }

    const reads = buildIndexReads(plan, bundle.schema, analysis.issues);
    if (!reads.length) {
      indexesPanel.innerHTML = emptyView(
        "No table-read index evidence in this bundle",
        "EXPLAIN PLAN indexes = 1, json = 1 <query>",
      );
    } else {
      indexesPanel.innerHTML = `<div class="view-heading"><div><span class="section-label">Read pruning</span><h3>${reads.length} table ${reads.length === 1 ? "read" : "reads"}</h3></div><p>Every condition and granule count below comes from the plan.</p></div><div class="index-list">${reads
        .map(
          (read) => `
        <article class="index-card" data-node-id="${read.nodeId}"><header><div><span class="section-label">${escapeHtml(read.engine || "Engine missing")}</span><h3>${escapeHtml(read.table)}</h3></div><button class="plan-node-link" type="button" data-node-id="${read.nodeId}">Plan step →</button></header>
          <div class="index-kpis"><div><span>Granules</span><b>${read.selectedGranules ?? "—"} / ${read.initialGranules ?? "—"}</b>${evidenceBadge(read.selectedGranules === null ? "missing" : "known")}</div><div><span>Parts</span><b>${read.selectedParts ?? "—"} / ${read.initialParts ?? "—"}</b>${evidenceBadge(read.selectedParts === null ? "missing" : "known")}</div></div>
          <dl><div><dt>Primary key</dt><dd>${escapeHtml(read.primary?.keys.length ? read.primary.keys.join(", ") : "Missing")}</dd></div><div><dt>Condition</dt><dd>${escapeHtml(read.primary?.condition || "Missing")}</dd></div></dl>
          <div class="skip-indexes">${read.skipping.length ? read.skipping.map((index) => `<div><b>${escapeHtml([index.type, index.name].filter(Boolean).join(" · "))}</b><code>${escapeHtml(index.condition || "Condition missing")}</code><span>${index.selectedGranules ?? "—"} / ${index.initialGranules ?? "—"} granules</span></div>`).join("") : `<p>No skipping indexes reported.</p>`}</div>
          ${read.suggestion ? `<p class="index-suggestion"><span>Finding · ${escapeHtml(read.suggestion.id)}</span>${escapeHtml(read.suggestion.text)}</p>` : ""}
        </article>`,
        )
        .join("")}</div>`;
    }
  }

  const lineage = createLineageView({
    panel: document.querySelector('[data-panel="lineage"]'),
    revealSQL: () => setRail('evidence', true),
    closeSQL: () => setRail('evidence', false),
    selectRead: node => {
      const read = allNodes.find(n => n.data.table?.name === node.name && (!node.database || n.data.table.database === node.database));
      if (read) window.highlightNodes(read.data.nodeId);
    },
  });

  function showView(name) {
    if (name === 'costs' || name === 'indexes') name = 'tables';
    document.querySelectorAll("[data-view]").forEach((tab) => {
      const active = tab.dataset.view === name;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".canvas-body > [data-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== name;
    });
    document
      .querySelector(".canvas-tools")
      .classList.toggle("river-tools-hidden", ['tables', 'pipelines'].includes(name));
    document.querySelector(".graph-actions").hidden = ['tables', 'pipelines'].includes(name);
    document.querySelector('.map-overflow').hidden = name !== 'river';
    document.querySelector('.canvas-body').dataset.activeView = name;
    if (name !== 'river') { setRail('inspector', false); setRail('evidence', false); }
    if (name === 'lineage') lineage.show();
    else lineage.hide();
    if (name === 'river') document.getElementById('graphZoom').textContent = `${Math.round(d3.zoomTransform(svg.node()).k * 100)}%`;
    document.dispatchEvent(new CustomEvent('chquery:view', { detail: { view: name } }));
  }

  function updateSuggestion(d) {
    const suggestion = document.querySelector(".suggestion-card");
    if (!suggestion) return;
    const nodeSuggestion = getNodeSuggestion(d?.data);
    suggestion.innerHTML = `
      <strong>${escapeHtml(nodeSuggestion.title)}</strong>
      <span>${escapeHtml(nodeSuggestion.body)}</span>
    `;
  }

  function getNodeDetails(d) {
    const data = d.data;
    const rows = [
      ["Type", data["Node Type"] || "Unknown"],
      ["Role", data.kind],
    ];

    if (data.Description) {
      rows.push(["Description", data.Description]);
    }

    rows.push(["Operator evidence", getStageEvidence([data]).join('\n')]);

    if (data.table) {
      rows.push(["Table", `${data.table.database}.${data.table.name}`]);
    }

    if (data.index) {
      rows.push(["Pruning stage", data.index.type]);
      rows.push([
        "Granules",
        `${formatNumber(data.index.selectedGranules)} / ${formatNumber(data.index.initialGranules)}`,
      ]);
      rows.push([
        "Selectivity",
        `${(data.index.selectivity * 100).toFixed(1)}%`,
      ]);
      if (data.index.keys?.length)
        rows.push(["Index keys", data.index.keys.join(", ")]);
      if (data.index.condition) rows.push(["Condition", data.index.condition]);
    }

    if (data.stats) {
      rows.push(["Est. scan rows", formatNumber(data.stats.rows)]);
      rows.push(["Parts", formatNumber(data.stats.parts)]);
      rows.push(["Marks", formatNumber(data.stats.marks)]);
      rows.push(["Rows / mark", formatNumber(data.stats.rowsPerMark)]);
    }

    rows.push(["Scan evidence", scanEvidence(d.data)]);
    return rows;
  }

  function renderInspector(d) {
    inspectedNode = d;
    const inspector = document.getElementById("nodeInspector");
    if (!inspector) return;

    if (!d) {
      inspector.innerHTML = `
        <div class="section-label">Selected step</div>
        <div class="inspector-empty">Select a node or highlight a finding to inspect it.</div>
      `;
      const rawDetails = document.getElementById("rawDetails");
      if (rawDetails) rawDetails.textContent = "No step selected.";
      updateSuggestion(null);
      return;
    }

    const title = escapeHtml(getNodeHeadline(d.data));
    const subtitle = escapeHtml(
      d.data.Description || d.data["Node Type"] || "Unknown",
    );
    const detailRows = getNodeDetails(d);
    const details = detailRows
      .map(
        ([label, value]) => `
      <div class="detail-row">
        <div class="detail-label">${escapeHtml(label)}</div>
        <div class="detail-value">${escapeHtml(value)}</div>
      </div>
    `,
      )
      .join("");
    const nodeId = window.currentAnalysis?.nodeStats?.get(d)?.id;
    const related = (window.currentAnalysis?.issues || []).filter((issue) =>
      issue.nodeIds?.includes(nodeId),
    );
    const upgradeNotes = related.filter(
      (issue) => issue.type === "default_moved_since_version",
    );
    const currentFindings = related.filter(
      (issue) => issue.type !== "default_moved_since_version",
    );
    const relatedSettings = currentFindings.filter(
      (issue) => issue.settingEvidence,
    );
    const settingsHtml = relatedSettings
      .map((issue) => {
        const evidence = issue.settingEvidence;
        return `<div class="inspector-setting"><code>${escapeHtml(evidence.setting)}</code><span><s>${escapeHtml(evidence.default_for_version)}</s> → <b>${escapeHtml(evidence.current)}</b></span><p>${escapeHtml(evidence.why)}</p></div>`;
      })
      .join("");
    const renderRelated = (issues) =>
      issues
        .map(
          (issue) => `
      <article class="inspector-finding severity-${issue.severity}">
        <strong>${escapeHtml(observationText(issue))}</strong>
        <p>One thing to try — ${escapeHtml(issue.recommendation)} <small class="finding-confidence">${escapeHtml(issue.confidence)}</small></p>
        <details class="finding-why"><summary>Why</summary><p>${escapeHtml(issue.why)}</p><dl class="finding-evidence">${(issue.evidence || []).map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl></details>
        ${reviewControls(issue)}
      </article>
    `,
        )
        .join("");
    const selectivity = d.data.index
      ? `${(d.data.index.selectivity * 100).toFixed(1)}%`
      : "—";
    const rows = d.data.stats ? formatNumber(d.data.stats.rows) : "—";

    inspector.innerHTML = `
      <div class="inspector-kind"><i class="heat-${d.data.heatLevel || 0}"></i>${escapeHtml(d.data.kind)}</div>
      <h3 class="inspector-title">${title}</h3>
      <p class="inspector-subtitle">${subtitle}</p>
      <div class="inspector-kpis"><div><span>Est. scan rows</span><b>${rows}</b></div><div><span>Granules kept</span><b>${selectivity}</b></div><div><span>Pruning heat</span><b>${d.data.heatLevel ? `${d.data.heatLevel}/5` : "—"}</b></div></div>
      <button type="button" class="text-button metric-help" data-map-help aria-label="How to read these metrics" aria-haspopup="dialog">?</button>
      ${currentFindings.length ? `<div class="node-findings"><div class="section-label">Findings on this step</div>${renderRelated(currentFindings)}</div>` : ""}
      <div class="section-label evidence-heading">Evidence</div>
      <div class="detail-grid">${details}</div>
      ${settingsHtml ? `<details class="node-settings"><summary>Settings (${relatedSettings.length})</summary>${settingsHtml}</details>` : ""}
      ${upgradeNotes.length ? `<details class="upgrade-notes"><summary>Upgrade notes (${upgradeNotes.length})</summary>${renderRelated(upgradeNotes)}</details>` : ""}
    `;

    const rawDetails = document.getElementById("rawDetails");
    if (rawDetails) rawDetails.textContent = JSON.stringify(d.data, null, 2);
    updateSuggestion(d);
  }

  function updateSqlPreview() {
    const sqlPreview = document.getElementById("sqlPreview");
    const queryMeta = document.getElementById("queryMeta");
    const query = wizardState.originalQuery.trim();
    if (!sqlPreview || !queryMeta) return;

    sqlPreview.textContent = query || "No SQL provided.";
    queryMeta.textContent = query
      ? `${query.split(/\s+/).filter(Boolean).length.toLocaleString()} words`
      : "No query loaded";
  }

  function updatePipelineTimeline(root) {
    const timeline = document.getElementById("pipelineTimeline");
    const pipelineMeta = document.getElementById("pipelineMeta");
    if (!timeline || !pipelineMeta) return;

    const nodes = root.descendants().slice(0, 7);
    pipelineMeta.textContent = `${root.descendants().length.toLocaleString()} plan steps`;
    timeline.innerHTML = nodes
      .map((node, index) => {
        const widthPct = Math.max(
          18,
          Math.min(
            100,
            ((node.value || 1) / Math.max(root.value || 1, 1)) * 100,
          ),
        );
        const heat = widthPct > 70 ? "hot" : widthPct > 35 ? "warm" : "good";
        return `
        <div class="timeline-step ${heat}">
          <span>${escapeHtml(String(index + 1).padStart(2, "0"))} ${escapeHtml(node.data["Node Type"] || "Step")}</span>
          <span class="timeline-bar"></span>
        </div>
      `;
      })
      .join("");
  }

  function updateEvidenceRail() {
    const items = [
      ["evidenceSql", wizardState.originalQuery],
      ["evidencePlan", wizardState.explainPlan],
      ["evidenceStats", wizardState.explainEstimate],
      [
        "evidenceServer",
        [
          wizardState.serverVersion,
          wizardState.cloudMode,
          wizardState.changedSettings,
        ]
          .filter((value) => value !== "" && value != null)
          .join(" "),
      ],
    ];

    const completeCount = items.reduce((count, [id, value]) => {
      const item = document.getElementById(id);
      const isComplete = Boolean(value && value.trim());
      if (item) {
        item.classList.toggle("complete", isComplete);
        const state = item.querySelector(".evidence-state");
        if (state)
          state.textContent = isComplete
            ? "Ready"
            : ["evidenceServer", "evidenceStats"].includes(id)
              ? "Optional"
              : "Missing";
      }
      return count + (isComplete ? 1 : 0);
    }, 0);

    const status = document.getElementById("evidenceStatus");
    if (status) {
      const requiredCount = items
        .slice(0, 3)
        .filter(([, value]) => Boolean(value && value.trim())).length;
      status.textContent =
        requiredCount === 3
          ? "Ready"
          : requiredCount >= 2
            ? "Partial"
            : `${requiredCount}/3`;
      status.classList.toggle(
        "partial",
        requiredCount >= 2 && requiredCount < 3,
      );
    }
    const exportButton = document.getElementById("exportBundleButton");
    if (exportButton) exportButton.disabled = completeCount < 2;
    const reportButton = document.getElementById("copyMarkdownReportButton");
    if (reportButton) reportButton.disabled = completeCount < 2;
    const shareButton = document.getElementById("copyShareLinkButton");
    if (shareButton) shareButton.disabled = completeCount < 2;
    document.getElementById("openStoredShare").disabled = completeCount < 2;
    updateSqlPreview();
  }

  function getGraphBounds(layout) {
    return layout.descendants().reduce(
      (acc, node) => {
        const halfWidth = node.data.dimensions.width / 2;
        const x = node.x;
        const y = node.y;
        return {
          left: Math.min(acc.left, x - halfWidth),
          right: Math.max(acc.right, x + halfWidth),
          top: Math.min(acc.top, y),
          bottom: Math.max(acc.bottom, y + node.data.dimensions.height),
        };
      },
      { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
    );
  }

  function getFitTransform(layout) {
    const bounds = getGraphBounds(layout);
    const graphWidth = bounds.right - bounds.left;
    const graphHeight = bounds.bottom - bounds.top;
    const scale = Math.min(
      1,
      Math.max(1, width - 96) / graphWidth,
      Math.max(1, height - 96) / graphHeight,
    );
    const dx = width / 2 - (bounds.left + graphWidth / 2) * scale;
    const dy = height / 2 - (bounds.top + graphHeight / 2) * scale;

    return d3.zoomIdentity.translate(dx, dy).scale(scale);
  }

  function fitDemo() {
    width = container.node().clientWidth;
    height = container.node().clientHeight;
    svg.attr("height", height).attr("viewBox", [0, 0, width, height]);
    currentFitTransform = getFitTransform(currentLayout);
    // The homepage is a readable entry into the example, not a personal-result overview.
    const source = currentLayout.leaves().sort((a, b) => a.x - b.x || a.y - b.y)[0];
    const top = Math.min(...currentLayout.descendants().filter(node => node.x <= source.x + 340).map(node => node.y - 8));
    const scale = Math.max(currentFitTransform.k, Math.min(.85, (width - 96) / 260));
    fitted = scale === currentFitTransform.k;
    applyGraphTransform(fitted ? currentFitTransform : d3.zoomIdentity
      .translate(48 - (source.x - 130) * scale, 48 - top * scale).scale(scale), 0);
  }

  function applyGraphTransform(transform, duration = 450) {
    svg.interrupt();
    if (!duration || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      svg.call(zoom.transform, transform);
      return;
    }
    svg.transition().duration(duration).call(zoom.transform, transform);
  }

  function updateMinimapViewport(transform) {
    const rect = d3.select("#graphMinimap .minimap-viewport");
    if (rect.empty()) return;
    const [x, y] = transform.invert([0, 0]);
    rect
      .attr("x", x)
      .attr("y", y)
      .attr("width", width / transform.k)
      .attr("height", height / transform.k);
  }

  new ResizeObserver(() => {
    const nextWidth = container.node().clientWidth;
    const nextHeight = container.node().clientHeight;
    if (
      !nextWidth ||
      !nextHeight ||
      (nextWidth === width && nextHeight === height)
    )
      return;
    const transform = d3.zoomTransform(svg.node());
    const center = transform.invert([width / 2, height / 2]);
    width = nextWidth;
    height = nextHeight;
    svg.attr("height", height).attr("viewBox", [0, 0, width, height]);
    if (!currentLayout) return;
    if (document.body.dataset.page === "home") {
      const selected = inspectedNode;
      render(currentRoot);
      if (selected)
        selectGraphNode(selected, {
          trace: false,
          focus: expandedChains.size > 0,
          duration: 0,
        });
      if (!expandedChains.size) fitDemo();
      return;
    }
    currentFitTransform = getFitTransform(currentLayout);
    const selected = document.querySelector(".node.selected")?.__data__;
    const scale = selected
      ? Math.min(transform.k, (width - 24) / selected.data.dimensions.width)
      : transform.k;
    applyGraphTransform(
      fitted
        ? currentFitTransform
        : d3.zoomIdentity
            .translate(
              width / 2 - center[0] * scale,
              height / 2 - center[1] * scale,
            )
            .scale(scale),
      0,
    );
  }).observe(container.node());

  let tracedNodes = [];
  function tracePath(nodes = []) {
    tracedNodes = nodes;
    const included = new Set();
    const upstream = (node) => {
      included.add(node);
      node.planChildren?.forEach(upstream);
    };
    for (const node of nodes) {
      upstream(node);
      for (let parent = node.planParent; parent; parent = parent.planParent)
        included.add(parent);
    }
    const onPath = (stage) =>
      (stage.grouped || [stage]).some((node) => included.has(node));
    container.classed("path-tracing", nodes.length > 0);
    g.selectAll(".node").classed("on-path", onPath);
    g.selectAll(".map-link, .map-chevron").classed(
      "on-path",
      (link) => onPath(link.source) && onPath(link.target),
    );
    if (nodes.length) {
      container.classed("bottleneck-only", false);
      document
        .getElementById("bottleneckButton")
        .setAttribute("aria-pressed", "false");
    }
  }

  function selectGraphNode(d, options = {}) {
    const stage = currentLayout
      .descendants()
      .find((node) => node === d || node.grouped?.includes(d));
    if (stage !== d && !expandedChains.has(stage.data.nodeId)) {
      expandedChains.add(stage.data.nodeId);
      render(currentRoot, stage);
    }
    d3.selectAll(".node").classed("selected", false);
    d3.selectAll(".node")
      .filter((node) => node === stage)
      .classed("selected", true);
    g.selectAll(".map-link").classed("selected-current", link => link.source === stage);
    d3.selectAll(".node").attr("tabindex", (node) => (node === stage ? 0 : -1));
    d3.selectAll(".stage-step").classed("selected-step", (node) => node === d);
    if (options.inspect) {
      setRail("inspector", true);
      width = container.node().clientWidth;
      height = container.node().clientHeight;
      svg.attr("height", height).attr("viewBox", [0, 0, width, height]);
      currentFitTransform = getFitTransform(currentLayout);
    }
    renderInspector(d);
    if (options.trace !== false) tracePath([d]);

    if (options.focus) {
      fitted = false;
      const scale = Math.min(
        options.scale || 1,
        (width - 24) / stage.data.dimensions.width,
      );
      const targetX = width / 2 - stage.x * scale;
      const row =
        stage.grouped && d !== stage
          ? stage.grouped.length - 1 - stage.grouped.indexOf(d)
          : null;
      const targetY =
        stage.data.dimensions.height * scale > height - 32
          ? row === null
            ? 24 - stage.y * scale
            : height / 2 - (stage.y + stage.cardHeight + 19 + row * 34) * scale
          : height / 2 - (stage.y + stage.data.dimensions.height / 2) * scale;
      applyGraphTransform(
        d3.zoomIdentity.translate(targetX, targetY).scale(scale),
        options.duration ?? 550,
      );
    }
  }

  function setGraphControlsEnabled(enabled) {
    document.getElementById("fitGraphButton").disabled = !enabled;
    document.getElementById("zoomOutButton").disabled = !enabled;
    document.getElementById("zoomInButton").disabled = !enabled;
    document.getElementById("bottleneckButton").disabled = !enabled;
    document.getElementById("groupStepsButton").disabled = !enabled;
    document.getElementById("mapDetailsButton").disabled = !enabled;
  }

  function render(root, anchor = null) {
    const firstRender = g.select('.node').empty();
    const transform = d3.zoomTransform(svg.node());
    const oldAnchor = anchor && transform.apply([anchor.x, anchor.y]);
    const duration =
      anchor && !matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 200
        : 0;
    // Restore the full hierarchy before deriving the visible, grouped tree.
    for (const node of allNodes) {
      node.children = node.planChildren;
      node.parent = node.planParent;
      node.grouped = null;
    }
    const issues = window.currentAnalysis?.issues || [];
    function group(node) {
      if (node.children?.length === 1) {
        const chain = [node];
        let last = node;
        let hasOperation = !isPreparation(node.data);
        while (
          last.children?.length === 1 &&
          last.children[0].children?.length === 1
        ) {
          const next = last.children[0];
          if (hasOperation && !isPreparation(next.data)) break;
          hasOperation ||= !isPreparation(next.data);
          last = next;
          chain.push(last);
        }
        if (chain.length > 1) {
          node.grouped = chain;
          node.children = last.children;
          node.children.forEach((child) => {
            child.parent = node;
          });
        }
      }
      node.children?.forEach(group);
      node.data.dimensions = getNodeDimensions(node);
    }
    group(root);

    // Compute the layout
    const layout = flextree(root);
    const farthest = d3.max(
      layout.descendants(),
      (node) => node.y + node.data.dimensions.width,
    );
    layout.each((node) => {
      const crossAxis = node.x;
      node.x = farthest - node.y - node.data.dimensions.width / 2;
      node.y = Math.round(crossAxis / 16) * 16;
    });
    currentLayout = layout;
    currentRoot = root;

    // Size the canvas to the plan's breadth, not a fixed expanse of empty space.
    // Expansion keeps the viewport stable so the opened stage stays anchored.
    if (!anchor) {
      const bounds = getGraphBounds(layout);
      workspace.style.setProperty(
        "--map-height",
        `${Math.ceil(Math.max(360, Math.min(640, (bounds.bottom - bounds.top) * 0.85 + 48)))}px`,
      );
      width = container.node().clientWidth;
      height = container.node().clientHeight;
      svg.attr("height", height).attr("viewBox", [0, 0, width, height]);
    }

    const flowingLinks = layout.links();
    const linkPath = (link) => {
      const sourceX = link.target.x + link.target.data.dimensions.width / 2;
      const sourceY = link.target.y + link.target.data.dimensions.height / 2;
      const targetX = link.source.x - link.source.data.dimensions.width / 2 - 6;
      const targetY = link.source.y + link.source.data.dimensions.height / 2;
      return `M${sourceX},${sourceY} C${(sourceX + targetX) / 2},${sourceY} ${(sourceX + targetX) / 2},${targetY} ${targetX},${targetY}`;
    };

    // Grouped cards connect the deepest parent member to the child's first member.
    const estimated = layout.leaves().every(node => Number.isFinite(node.data.ownRows));
    const inputRows = node => node.children?.length ? d3.sum(node.children, inputRows) : node.data.ownRows;
    const edgeRows = link => estimated ? inputRows(link.target) : null;
    const maximum = Math.max(1, ...flowingLinks.map(link => edgeRows(link) ?? 0));
    const hasMeasuredEdges = flowingLinks.some(link => edgeRows(link) !== null);
    document.getElementById('mapEdgeLegend').textContent = hasMeasuredEdges
      ? 'Width = log estimated input rows (1.5–6px), not measured output'
      : 'Dependencies, not volume · Drag to explore · Fit for overview';
    const links = g.selectAll("g.links")
      .data([null])
      .join("g")
      .attr("class", "links")
      .selectAll("path")
      .data(flowingLinks, (link) => link.target.data.nodeId)
      .join("path")
      .attr("class", link => `map-link${edgeRows(link) !== null ? ' estimated-link' : ''}`)
      .style('stroke-width', link => estimated ? 1.5 + 4.5 * Math.log1p(edgeRows(link)) / Math.log1p(maximum) : 2)
      .attr('aria-label', link => edgeRows(link) === null ? 'Dependency; volume unknown' : `${edgeRows(link)} estimated input rows`);
    links.selectAll('title').data(link => [link]).join('title').text(link => edgeRows(link) === null ? 'Dependency; volume unknown' : `${edgeRows(link)} estimated input rows, not measured output`);
    links.transition()
      .duration(duration)
      .attr("d", linkPath);
    if (firstRender && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      links.attr('d', linkPath).each(function () {
        const length = this.getTotalLength();
        d3.select(this).attr('stroke-dasharray', length).attr('stroke-dashoffset', length)
          .transition('intro').duration(400).attr('stroke-dashoffset', 0)
          .on('end', function () { d3.select(this).attr('stroke-dasharray', null).attr('stroke-dashoffset', null); });
      });
    }
    g.selectAll('.map-chevron').data(flowingLinks, link => link.target.data.nodeId).join('path')
      .attr('class', 'map-chevron')
      .attr('d', link => { const x = link.source.x - 136; const y = link.source.y + link.source.data.dimensions.height / 2; return `M${x - 4},${y - 4}l4,4l-4,4`; });

    const hottestSource = layout
      .leaves()
      .filter((node) => node.data.heatLevel > 0)
      .sort(
        (left, right) =>
          right.data.index.selectivity - left.data.index.selectivity,
      )[0];
    const bottleneckNodes = new Set(hottestSource?.ancestors() || []);
    g.selectAll("g.bottleneck-flow")
      .data([null])
      .join("g")
      .attr("class", "bottleneck-flow")
      .selectAll("path")
      .data(flowingLinks.filter((link) => bottleneckNodes.has(link.target)))
      .join("path")
      .attr("class", "bottleneck-current")
      .transition()
      .duration(duration)
      .attr("d", linkPath);

    // Create node groups
    const nodes = g
      .selectAll("g.nodes")
      .data([null])
      .join("g")
      .attr("class", "nodes")
      .selectAll("g.node")
      .data(layout.descendants(), (node) => node.data.nodeId)
      .join("g")
      .attr("class", (d) => {
        const classes = ["node", `stage-${d.summary.kind}`];
        if (detailedMap) classes.push('details-card');
        if (d.data["Node Type"]?.toLowerCase().includes("join")) {
          classes.push("join");
        }
        if (d.data["Node Type"] === "ReadFromMergeTree") {
          classes.push("leaf");
        }
        return classes.join(" ");
      })
      .attr("tabindex", -1)
      .attr("role", "button")
      .attr(
        "aria-label",
        (d) =>
          `${d.summary.title}. ${d.summary.detail}. ${d.evidence.join('. ')}. ${d.cue || ''} ${d.grouped ? `${d.grouped.length} operators. Toggle to inspect.` : 'Inspect operator.'}`,
      )
      .attr("aria-expanded", (d) =>
        d.grouped ? String(expandedChains.has(d.data.nodeId)) : null,
      )
      .classed("grouped", (d) => Boolean(d.grouped))
      .classed("pruning-path", (d) => bottleneckNodes.has(d));
    nodes
      .transition()
      .duration(duration)
      .attr("transform", (d) => `translate(${d.x},${d.y})`);
    if (firstRender && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const left = d3.min(layout.descendants(), node => node.x);
      nodes.style('opacity', 0).transition('intro').delay(node => (node.x - left) / 340 * 40)
        .duration(200).style('opacity', null);
    }
    nodes.selectAll("*").remove();
    nodes.filter(d => d.grouped && !expandedChains.has(d.data.nodeId)).each(function (d) {
      d3.select(this).selectAll('.stack-outline').data([8, 4]).join('rect')
        .attr('class', 'stack-outline').attr('x', offset => -130 + offset)
        .attr('y', offset => -offset).attr('width', 260).attr('height', d.cardHeight).attr('rx', 10);
    });

    nodes.append("title").text((d) => {
      const headline = d.data.table
        ? `${d.data.table.database}.${d.data.table.name}`
        : d.data.Description || d.data["Node Type"] || "Unknown";
      return `${headline} · ${d.summary.detail}\n${d.evidence.join('\n')}${d.cue ? `\n${d.cue}` : ''}`;
    });

    // Compact evidence cards keep a large plan legible at fit-to-screen.
    nodes
      .append("rect")
      .attr("class", "stage-surface")
      .attr("width", (d) => d.data.dimensions.width)
      .attr("height", (d) => d.data.dimensions.height)
      .attr("x", (d) => -d.data.dimensions.width / 2)
      .attr("y", 0)
      .attr("rx", 10);
    nodes.on("click", function (event, d) {
      event.stopPropagation();
      selectGraphNode(d, { inspect: true });
    }).on('mouseenter', (event, d) => tracePath([d]))
      .on('mouseleave', () => tracePath(inspectedNode ? [inspectedNode] : []))
      .on('dblclick', function (event, d) {
      event.preventDefault(); event.stopPropagation();
      if (d.grouped) {
        if (expandedChains.has(d.data.nodeId))
          expandedChains.delete(d.data.nodeId);
        else expandedChains.add(d.data.nodeId);
        render(currentRoot, d);
      }
      selectGraphNode(d, { inspect: true });
    });

    const glyphs = {
      source:
        "M-9,-7 Q0,-12 9,-7 L9,7 Q0,12 -9,7 Z M-9,-7 Q0,-2 9,-7 M-9,0 Q0,5 9,0",
      join: "M-10,-8 L-3,-8 Q3,-8 3,0 L10,0 M-10,8 L-3,8 Q3,8 3,0",
      union: "M-10,-8 L0,0 L10,0 M-10,8 L0,0",
      aggregate: "M-10,-8 H-4 L4,0 H10 M-10,0 H4 M-10,8 H-4 L4,0",
      sort: "M-9,-7 H9 M-5,0 H9 M0,7 H9",
      window: "M-10,-9 H10 V9 H-10 Z M-10,-3 H10 M-3,-9 V9",
      distinct: "M-9,-8 H3 V4 H-9 Z M-3,-2 H9 V10 H-3 Z",
      limit: "M-10,-6 H10 M-10,0 H10 M-10,6 H10 M13,-10 V10",
      filter: "M-10,-8 H10 L3,1 V9 H-3 V1 Z",
      transform: "M-10,0 H10 M3,-7 L10,0 L3,7",
      result: "M-8,0 L-2,6 L9,-7",
    };
    nodes.each(function (d) {
      const node = d3.select(this);
      const left = -d.data.dimensions.width / 2 + 18;
      node
          .append("circle")
          .attr("class", "stage-symbol")
          .attr("cx", left + 12)
          .attr("cy", 25)
          .attr("r", 17);
      node
        .append("path")
        .attr("class", "stage-glyph")
        .attr(
          "transform",
          `translate(${left + 12},25) scale(.8)`,
        )
        .attr("d", glyphs[d.summary.kind]);
      const headline = node.append("text").attr("class", "node-name");
      d.cardLines.forEach((line, index) =>
        headline
          .append("tspan")
          .attr("x", left + 38)
          .attr("y", 30 + index * 20)
          .text(line),
      );
      context.font = `12px ${getComputedStyle(document.body).getPropertyValue('--font-mono')}`;
      d.visibleEvidence.forEach((line, index) => {
        node.append('text').attr('class', 'node-evidence')
          .attr('x', left).attr('y', d.evidenceTop + index * 19)
          .text(fitCardText(line, d.data.dimensions.width - 36))
          .attr('textLength', function () { return context.measureText(this.textContent).width; })
          .attr('lengthAdjust', 'spacingAndGlyphs')
          .append('title').text(line);
      });
      if (d.cue) node.append('text').attr('class', 'node-cue')
        .attr('x', left).attr('y', d.evidenceTop + d.visibleEvidence.length * 19 + 6)
        .attr('role', 'button').attr('tabindex', 0).attr('aria-label', `${d.cue}. ${d.candidate.message}`)
        .on('click keydown', event => {
          if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const target = (d.grouped || [d]).find(member => d.candidate.nodeIds.includes(member.data.nodeId));
          selectGraphNode(target, { inspect: true, focus: true });
        })
        .text(fitCardText(d.cue, d.data.dimensions.width - 36))
        .attr('textLength', function () { return context.measureText(this.textContent).width; })
        .attr('lengthAdjust', 'spacingAndGlyphs')
        .append('title').text(`${d.candidate.message}\nHypothesis, not a measured bottleneck. Inspect supporting and weakening checks.`);
      node
        .append("text")
        .attr("class", "node-count")
        .attr("x", 116)
        .attr("y", 16)
        .text(
          d.grouped
            ? `+${d.grouped.length - 1}`
            : '',
        );
      if (d.grouped && expandedChains.has(d.data.nodeId)) {
        const steps = node
          .selectAll(".stage-step")
          .data([...d.grouped].reverse())
          .join("g")
          .attr("class", "stage-step")
          .attr(
            "transform",
            (_, index) => `translate(${left},${d.cardHeight + 4 + index * 34})`,
          )
          .attr("role", "button")
          .attr("tabindex", 0)
          .attr(
            "aria-label",
            (member) =>
              `${getNodeCardKind(member.data)}: ${getNodeHeadline(member.data)}`,
          )
          .on("click keydown", (event, member) => {
            if (event.type === "keydown" && !["Enter", " "].includes(event.key))
              return;
            event.preventDefault();
            event.stopPropagation();
            selectGraphNode(member, { inspect: true });
          });
        steps
          .append("rect")
          .attr("width", 224)
          .attr("height", 30)
          .attr("rx", 4);
        steps
          .append("text")
          .attr("x", 8)
          .attr("y", 20)
          .text((member) => truncate(getNodeCardKind(member.data), 26));
        steps
          .append("title")
          .text(
            (member) =>
              `${getNodeHeadline(member.data)} · ${scanEvidence(member.data)}`,
          );
      }
    });

    const minimap = document.getElementById("graphMinimap");
    const bounds = getGraphBounds(layout);
    minimap.hidden = getFitTransform(layout).k >= 0.85;
    minimap.innerHTML = `<svg viewBox="${bounds.left - 20} ${bounds.top - 20} ${bounds.right - bounds.left + 40} ${bounds.bottom - bounds.top + 40}" role="img" aria-label="Plan overview. Click a step to navigate.">${flowingLinks.map((link) => `<line x1="${link.source.x}" y1="${link.source.y}" x2="${link.target.x}" y2="${link.target.y}" />`).join("")}${layout
      .descendants()
      .map(
        (node) =>
          `<rect x="${node.x - node.data.dimensions.width / 2}" y="${node.y}" width="${node.data.dimensions.width}" height="${node.data.dimensions.height}" />`,
      )
      .join("")}<rect class="minimap-viewport" /></svg>`;
    minimap.querySelector("svg").addEventListener("click", (event) => {
      const point = d3.pointer(event, event.currentTarget);
      const nearest = layout
        .descendants()
        .reduce((best, node) =>
          Math.hypot(node.x - point[0], node.y - point[1]) <
          Math.hypot(best.x - point[0], best.y - point[1])
            ? node
            : best,
        );
      selectGraphNode(nearest, { focus: true });
    });
    currentFitTransform = getFitTransform(layout);
    fitted = !anchor;
    applyGraphTransform(
      anchor
        ? d3.zoomIdentity
            .translate(
              oldAnchor[0] - anchor.x * transform.k,
              oldAnchor[1] - anchor.y * transform.k,
            )
            .scale(transform.k)
        : currentFitTransform,
      duration,
    );
    document
      .getElementById("groupStepsButton")
      .setAttribute("aria-pressed", String(expandedChains.size > 0));
    document.getElementById("groupStepsButton").textContent =
      expandedChains.size ? "Close all stages" : "Open all stages";
    setGraphControlsEnabled(true);
    document.getElementById("bottleneckButton").disabled = !hottestSource;
    if (!hottestSource) {
      document
        .getElementById("bottleneckButton")
        .setAttribute("aria-pressed", "false");
      container.classed("bottleneck-only", false);
    }
    tracePath(tracedNodes);
  }

  // --- Main Processing Function ---
  let importGeneration = 0;
  async function processInput(
    generation,
    state,
    { demo = false, restore = false } = {},
  ) {
    try {
      state = { ...state, bundle: bundleFromWizard(state) };
      // Resolve dependencies before publishing any graph or analysis state.
      const [catalog, concerns] = bundleNeedsSettingsData(state.bundle)
        ? await loadSettingsData()
        : [];
      if (generation !== importGeneration) return null;
      await document.fonts.ready;
      // Canvas measurement can request weights not yet used by the homepage.
      const graphFont = getComputedStyle(document.body).getPropertyValue(
        "--font-ui",
      );
      await Promise.all(
        [500, 600].map((weight) =>
          document.fonts.load(`${weight} 17px ${graphFont}`),
        ),
      );
      if (generation !== importGeneration) return null;
      const parsedPlan = parseExplainPlan(state.explainPlan);
      const estimateData = parseEstimate(state.explainEstimate);
      const transformedData = buildPlanModel(parsedPlan, estimateData);
      const analyze = attachAnalyze(transformedData, state.bundle);
      const root = d3.hierarchy(transformedData, (d) => d.children);
      const evaluation = evaluateFindings(transformedData, {
        sql: state.originalQuery,
        syntax: state.bundle?.explain?.syntax,
        clickhouse: state.bundle?.clickhouse,
        settings: state.bundle?.settings,
        schema: state.bundle?.schema,
        catalog,
        concerns,
      });
      const analysis = {
        ...evaluation,
        issues: evaluation.findings,
        coverage: buildEvidenceCoverage(
          transformedData,
          estimateData,
          state.bundle,
        ),
        nodeStats: new Map(
          root.descendants().map((node) => [node, { id: node.data.nodeId }]),
        ),
      };
      const prepared = await prepareRuntime(state.bundle, analysis.coverage, {
        selectedGroup: !demo && restore ? personalMeasurementGroup : undefined,
      });
      if (generation !== importGeneration) return null;
      Object.assign(analysis, prepared);
      if (!demo && !restore) {
        preferredInvestigation = null;
        personalMeasurementGroup = undefined;
        document.getElementById("summaryContent").hidden = false;
        document
          .getElementById("toggleSummary")
          .setAttribute("aria-expanded", "true");
        document.getElementById("toggleSummary").textContent =
          "Collapse summary";
      }
      // The latest valid input publishes SQL, exports and analysis together.
      wizardState = state;
      document.getElementById('analyzeStatus').hidden = analyze.status === 'missing';
      document.getElementById('analyzeStatus').textContent = analyze.message;
      activeDemo = demo;
      if (!demo) personalState = structuredClone(state);
      review = demo ? demoReview : personalReview;
      setPageView(demo ? "home" : "results", !restore);
      review.publish(state.bundle);
      groupUndo.clear();
      analysis.candidates = selectCandidates(
        analysis.issues,
        review.snapshot(),
      );
      analysis.brief = briefFromBundle(state.bundle, { catalog, concerns });
      if (!demo && !restore) personalReportOption = false;
      includeReviewReport = !demo && restore && personalReportOption;
      for (const [id, value] of Object.entries({
        originalQuery: state.originalQuery,
        explainResult: state.explainPlan,
        estimateResult: state.explainEstimate,
        serverVersion: state.serverVersion,
        cloudMode: state.cloudMode,
        changedSettings: state.changedSettings,
        jsonInput: state.explainPlan,
      })) {
        document.getElementById(id).value = value || "";
      }
      window.estimateData = estimateData;
      allNodes = root.descendants();
      lineage.load({ sql: state.originalQuery, planReads: allNodes.filter(n => n.data['Node Type'] === 'ReadFromMergeTree').map(n => n.data), estimates: state.bundle.explain.estimate || [] });
      for (const node of allNodes) {
        node.planChildren = node.children;
        node.planParent = node.parent;
      }
      expandedChains.clear();
      tracedNodes = [];
      document
        .getElementById("groupStepsButton")
        .setAttribute("aria-pressed", "false");
      setRail("evidence", false);
      setRail("inspector", false);
      document.querySelector(".plan-search").value = "";
      container.classed("bottleneck-only", false);
      document
        .getElementById("bottleneckButton")
        .setAttribute("aria-pressed", "false");

      // Clear existing visualization
      g.selectAll("*").remove();
      const placeholder = document.getElementById("graphPlaceholder");
      if (placeholder) {
        placeholder.style.display = "none";
      }

      // Add estimate data
      console.log("Parsed estimate data:", window.estimateData);

      // Aggregate leaf "granules" upward
      root.sum((d) => d.granules || 0);

      // Compute and display stats
      const stats = computePlanStats(transformedData);
      document.getElementById("planOverview").textContent =
        `${stats.totalNodes} steps · ${stats.totalTables} table reads · ${analysis.coverage.scans.label}`;
      const statsHtml = `
        <div class="section-label">
          Run summary
          <span class="status-pill">Parsed</span>
        </div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-value">${stats.totalNodes}</div>
            <div class="stat-label">Plan nodes</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.joinNodes}</div>
            <div class="stat-label">Join nodes</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.totalTables}</div>
            <div class="stat-label">Tables read</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.totalGranules.toLocaleString()}</div>
            <div class="stat-label">Selected granules</div>
          </div>
        </div>
      `;

      const statsDiv = document.getElementById("stats");
      statsDiv.innerHTML = statsHtml;
      renderInspector(null);
      updateEvidenceRail();
      updatePipelineTimeline(root);

      // Store current analysis for reference
      window.currentAnalysis = analysis;
      renderEvidenceViews(transformedData, analysis);
      renderAnalysisSummary(analysis);

      // Add recommendations panel
      const recommendationsHtml = formatRecommendations(analysis);
      const recommendationsContainer = document.getElementById(
        "recommendationsSlot",
      );
      recommendationsContainer.innerHTML = recommendationsHtml;

      // Render the tree
      render(root);
      document.getElementById("planOverview").textContent +=
        ` · ${currentLayout.descendants().length} stages`;
      const firstInput = currentLayout
        .leaves()
        .sort((a, b) => a.x - b.x || a.y - b.y)[0];
      selectGraphNode(firstInput, { trace: false });
      if (demo) {
        document.getElementById("demoSQL").textContent = state.originalQuery;
        document.getElementById("demoStructure").textContent =
          "Select a stage to trace its dependencies.";
        showView("river");
        render(root);
        selectGraphNode(firstInput, { trace: false });
        fitDemo();
      }
      return true;
    } catch (error) {
      if (generation !== importGeneration) return null;
      if (wizardState.bundle?.explain?.plan) return false;
      const placeholder = document.getElementById("graphPlaceholder");
      placeholder.classList.add("error-state");
      placeholder.style.display = "grid";
      placeholder.querySelector(".graph-empty-card").innerHTML = `
        <div class="state-mark">!</div><h2>We could not read that plan.</h2>
        <p>${escapeHtml(error.message)} Check that the paste is EXPLAIN PLAN JSON and try again.</p>
      `;
      return false;
    }
  }

  // --- Event Listeners ---
  document
    .getElementById("startAnalysis")
    .addEventListener("click", showWizard);
  document
    .getElementById("editEvidenceButton")
    .addEventListener("click", showWizard);
  document.addEventListener('click', event => {
    const tab = event.target.closest('[data-view]');
    if (tab) showView(tab.dataset.view);
  });
  const planSearch = document.querySelector(".plan-search");
  document.getElementById('mapDetailsButton').addEventListener('click', event => {
    if (!currentLayout) return;
    const selected = document.querySelector('.node.selected')?.__data__ || currentRoot;
    const inspected = inspectedNode;
    detailedMap = !detailedMap;
    event.currentTarget.setAttribute('aria-pressed', String(detailedMap));
    render(currentRoot, selected);
    selectGraphNode(inspected && (selected === inspected || selected.grouped?.includes(inspected)) ? inspected : selected, { focus: false, trace: false });
  });
  document.getElementById("groupStepsButton").addEventListener("click", () => {
    if (expandedChains.size) expandedChains.clear();
    else
      currentLayout
        .descendants()
        .filter((node) => node.grouped)
        .forEach((node) => expandedChains.add(node.data.nodeId));
    render(currentRoot);
    selectGraphNode(currentRoot, {
      focus: activeDemo && expandedChains.size > 0,
    });
  });
  planSearch.addEventListener("input", () => {
    if (dispatchViewControl('search', { query: planSearch.value })) return;
    if (!currentLayout) return;
    const query = planSearch.value.trim().toLowerCase();
    const matches = allNodes.filter(
      (node) =>
        query &&
        [
          node.data["Node Type"],
          node.data.Description,
          node.data.table &&
            `${node.data.table.database}.${node.data.table.name}`,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query)),
    );
    if (matches[0]) selectGraphNode(matches[0], { focus: true, inspect: true });
    d3.selectAll(".node").classed(
      "search-match",
      (node) =>
        matches.includes(node) ||
        node.grouped?.some((member) => matches.includes(member)),
    );
  });
  document
    .getElementById("bottleneckButton")
    .addEventListener("click", (event) => {
      const active =
        event.currentTarget.getAttribute("aria-pressed") !== "true";
      tracePath();
      event.currentTarget.setAttribute("aria-pressed", String(active));
      document
        .getElementById("treeContainer")
        .classList.toggle("bottleneck-only", active);
    });
  document
    .querySelector("#plan")
    .addEventListener("click", async (event) => {
      if (event.target.closest("[data-open-runtime]")) {
        openRuntime();
        return;
      }
      const copy = event.target.closest(".copy-command");
      if (copy) {
        let text = copy.parentElement.querySelector(".copy-fallback");
        if (!text) {
          text = document.createElement("pre");
          text.className = "query-display copy-fallback";
          text.tabIndex = 0;
          copy.after(text);
        }
        text.textContent = copy.dataset.command;
        text.hidden = false;
        let status = copy.parentElement.querySelector(".copy-status");
        if (!status) {
          status = document.createElement("p");
          status.className = "copy-status";
          status.setAttribute("role", "status");
          text.after(status);
        }
        await copyCollectionText(text, status);
        if (status.textContent.startsWith("Copied")) {
          copy.textContent = "Copied";
          text.hidden = true;
        } else text.hidden = false;
        return;
      }
      const link = event.target.closest("[data-node-id]");
      if (!link?.dataset.nodeId || !currentLayout) return;
      const node = allNodes.find(
        (item) => item.data.nodeId === link.dataset.nodeId,
      );
      if (node) {
        showView("river");
        selectGraphNode(node, { focus: true, inspect: true });
      }
    });
  document.addEventListener("keydown", (event) => {
    if (
      document.body.dataset.page === "wizard" ||
      document.querySelector("dialog[open]") ||
      document.body.dataset.comparison === "true" ||
      document.body.dataset.investigations === "true"
    )
      return;
    const activeElement = document.activeElement;
    const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(activeElement?.tagName);
    if (event.key === "/" && !editing) {
      event.preventDefault();
      planSearch.focus();
      planSearch.select();
      return;
    }
    if (event.key === "Escape") {
      const menu = document.activeElement?.closest(".finding-menu[open], .summary-more[open], .map-overflow[open]");
      if (menu) {
        menu.open = false;
        menu.querySelector("summary").focus();
        return;
      }
      tracePath();
      g.selectAll(".map-link").classed("selected-current", false);
      planSearch.value = "";
      planSearch.blur();
      d3.selectAll(".node").classed(
        "selected highlighted search-match keyboard-focus",
        false,
      );
      renderInspector(null);
      setRail('inspector', false);
      return;
    }
    if (!editing && ['f', 'F', '-', '=', '+'].includes(event.key)) {
      event.preventDefault();
      document.getElementById(event.key.toLowerCase() === 'f' ? 'fitGraphButton' : event.key === '-' ? 'zoomOutButton' : 'zoomInButton').click();
      return;
    }
    const graphFocused =
      activeElement === document.body ||
      activeElement?.classList.contains("node");
    if (
      editing ||
      !graphFocused ||
      !currentLayout ||
      document.querySelector('[data-panel="river"]').hidden
    )
      return;
    const selected = activeElement?.classList.contains("node")
      ? activeElement.__data__
      : document.querySelector(".node.selected")?.__data__ || currentRoot;
    let target;
    if (event.key === "ArrowRight") target = selected.parent;
    if (event.key === "ArrowLeft") target = selected.children?.[0];
    if (["ArrowUp", "ArrowDown"].includes(event.key) && selected.parent) {
      const siblings = selected.parent.children;
      const offset = event.key === "ArrowUp" ? -1 : 1;
      target = siblings[siblings.indexOf(selected) + offset];
    }
    if (event.key === "Enter" || event.key === " ") {
      target = selected;
    }
    if (!target) return;
    event.preventDefault();
    selectGraphNode(target, { focus: true, inspect: true });
    d3.selectAll(".node").classed("keyboard-focus", (node) => node === target);
    d3.selectAll(".node")
      .filter((node) => node === target)
      .node()
      ?.focus();
  });

  // Manual workspace state (the public wizard name remains for import compatibility).
  let wizardDraft = null;
  const emptyState = {
    analysisName: "",
    reviewQuestion: "",
    originalQuery: "",
    explainPlan: "",
    explainPlanQuery: "",
    explainEstimate: "",
    serverVersion: "",
    cloudMode: "",
    changedSettings: "",
    bundle: null,
  };
  let wizardState = structuredClone(emptyState);
  let activeDemo = false;
  let personalState = null;
  let suspendedWizard = null;
  let wizardReturn = "home";
  const wizardFields = [
    "analysisName",
    "reviewQuestion",
    "originalQuery",
    "explainResult",
    "estimateResult",
    "analyzeResult",
    "serverVersion",
    "cloudMode",
    "changedSettings",
  ];
  history.replaceState({ ...history.state, view: "home" }, "");

  function setPageView(view, navigate = true) {
    document.body.dataset.page = view;
    document.getElementById("analysisSummary").hidden = view !== "results";
    if (navigate && history.state?.view !== view)
      history.pushState({ view }, "");
    document.getElementById("resumeResults").hidden =
      !personalState || view === "results";
    document.getElementById("newAnalysis").hidden =
      !personalState && !suspendedWizard;
    document.getElementById("startAnalysis").textContent = suspendedWizard
      ? "Resume your query"
      : personalState
        ? "Edit your query"
        : "Collect step by step";
  }

  function suspendWizard() {
    if (!wizardDraft) return;
    suspendedWizard = {
      draft: structuredClone(wizardDraft),
      fields: Object.fromEntries(
        wizardFields.map((id) => [id, document.getElementById(id).value]),
      ),
      replace: document.getElementById("replaceQueryEvidence").checked,
      analyzeAssociated: document.getElementById('analyzeAssociated').checked,
    };
  }

  async function showHome(navigate = true) {
    suspendWizard();
    closeWizard();
    const generation = ++importGeneration;
    document.body.dataset.homeLoading = "true";
    const status = document.getElementById("demoLoadStatus");
    status.hidden = false;
    status.textContent = "Loading the example plan…";
    setPageView("home", navigate);
    try {
      const response = await fetch("./examples/home-demo.json");
      if (!response.ok)
        throw new Error(
          "Example unavailable. You can still analyze your query.",
        );
      const bundle = await response.json();
      if (generation !== importGeneration) return;
      const rendered = await controller.importState(
        wizardFromBundle(bundle),
        generation,
        { demo: true, restore: true },
      );
      if (generation !== importGeneration) return;
      if (!rendered) throw new Error("Could not render the example.");
      document.body.dataset.homeLoading = "false";
      status.hidden = true;
      window.scrollTo({ top: 0 });
    } catch (error) {
      if (generation !== importGeneration) return;
      status.textContent =
        "Example unavailable. Analyze your query to get started, or select CH Query to retry.";
    }
  }
  window.showHome = showHome;

  async function resumeResults(navigate = true) {
    if (!personalState) return showHome(navigate);
    const generation = ++importGeneration;
    await controller.importState(personalState, generation, { restore: true });
    if (generation === importGeneration) setPageView("results", navigate);
    if (generation === importGeneration)
      window.renderBundleMetadata?.(personalState.bundle);
  }
  document.getElementById("homeLink").addEventListener("click", (event) => {
    event.preventDefault();
    showHome();
  });
  document
    .getElementById("resumeResults")
    .addEventListener("click", () => resumeResults());
  document.getElementById("newAnalysis").addEventListener("click", () => {
    if (
      !confirm(
        "Discard your personal query, draft and analysis and start fresh?",
      )
    )
      return;
    personalState = null;
    suspendedWizard = null;
    personalReview.clear();
    showWizard();
  });
  window.addEventListener("popstate", () => {
    const view = history.state?.view || "home";
    if (!document.getElementById("queryWizard").hidden) {
      suspendWizard();
      closeWizard();
    }
    if (view === "wizard") showWizard(false);
    else if (view === "results") resumeResults(false);
    else showHome(false);
  });

  const controller = {
    showHome,
    showWizard,
    beginImport() {
      return ++importGeneration;
    },
    isCurrentImport(generation) {
      return generation === importGeneration;
    },
    getState() {
      return { ...wizardState };
    },
    getBrief() {
      return renderedBrief ? structuredClone(renderedBrief) : null;
    },
    renderPreparedBrief(bundle) {
      if (!window.currentAnalysis || activeDemo) return null;
      window.currentAnalysis.brief = briefFromBundle(bundle);
      renderAnalysisSummary(window.currentAnalysis);
      return structuredClone(renderedBrief);
    },
    selectComparisonRoles,
    getPersonalBundle() {
      return personalState?.bundle
        ? structuredClone(personalState.bundle)
        : null;
    },
    getReviewDispositions() {
      return review.snapshot();
    },
    includeReviewReport() {
      return includeReviewReport;
    },
    hasPersonalWork() {
      return Boolean(personalState || suspendedWizard || wizardDraft);
    },
    async importState(state, generation = ++importGeneration, options = {}) {
      if (generation !== importGeneration) return null;
      const input = structuredClone(state);
      input.serverVersion = input.bundle?.clickhouse?.version || "";
      input.cloudMode =
        input.bundle?.clickhouse?.cloud_mode === undefined
          ? typeof input.bundle?.clickhouse?.cloud === "boolean"
            ? String(Number(input.bundle.clickhouse.cloud))
            : ""
          : String(input.bundle.clickhouse.cloud_mode);
      input.changedSettings = (input.bundle?.settings?.changed || [])
        .map((setting) => JSON.stringify(setting))
        .join("\n");
      const rendered = await processInput(generation, input, options);
      if (rendered && generation === importGeneration) {
        if (!options.demo && !options.restore) suspendedWizard = null;
        closeWizard();
        setPageView(options.demo ? "home" : "results", false);
      }
      return generation === importGeneration ? rendered : null;
    },
  };

  const collectionElement = (id) => document.getElementById(id);
  for (const [id, key] of [
    ["versionSQL", "version"],
    ["cloudSQL", "cloud"],
    ["settingsSQL", "settings"],
    ["settingsFallbackSQL", "settingsWithoutDefault"],
  ])
    collectionElement(id).textContent = metadataSQL[key];
  document
    .querySelectorAll("[data-copy-collection]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        copyCollectionText(
          collectionElement(button.dataset.copyCollection),
          collectionElement("collectionCopyStatus"),
        ),
      ),
    );
  collectionElement("originalQuery").addEventListener("input", () => {
    ++importGeneration;
    collectionElement('analyzeAssociated').checked = false;
    collectionElement("replaceQueryEvidence").checked = false;
    refreshManualWorkspace();
  });
  collectionElement("explainResult").addEventListener("input", () => {
    ++importGeneration;
    collectionElement('analyzeAssociated').checked = false;
    if (collectionElement("explainResult").value.trim())
      wizardDraft.explainPlanQuery = collectionElement("originalQuery").value;
    refreshManualWorkspace();
  });
  for (const id of [
    "estimateResult",
    "analyzeResult",
    "serverVersion",
    "cloudMode",
    "changedSettings",
  ])
    collectionElement(id).addEventListener("input", () => {
      ++importGeneration;
      if (id !== 'estimateResult') collectionElement('analyzeAssociated').checked = false;
    });
  collectionElement("replaceQueryEvidence").addEventListener("change", () => {
    ++importGeneration;
    if (!collectionElement("replaceQueryEvidence").checked)
      return refreshManualWorkspace();
    wizardDraft.bundle = withoutQueryEvidence(wizardDraft.bundle || {});
    wizardDraft.explainPlan = "";
    wizardDraft.explainPlanQuery = "";
    wizardDraft.explainEstimate = "";
    collectionElement("explainResult").value = "";
    collectionElement("estimateResult").value = "";
    collectionElement('analyzeResult').value = '';
    collectionElement('analyzeAssociated').checked = false;
    refreshManualWorkspace();
    collectionElement("explainResult").focus();
  });

  const runtimeDialog = collectionElement("runtimeDialog");
  let runtimeBase = null;
  let runtimeGeneration = 0;
  function runtimeError(message, field = "runtimeResult") {
    collectionElement("runtimeError").textContent = message;
    collectionElement("runtimeError").hidden = false;
    const input = collectionElement(field);
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", "runtimeError");
    input.focus();
  }
  function clearRuntimeError() {
    collectionElement("runtimeError").hidden = true;
    runtimeDialog.querySelectorAll("[aria-invalid]").forEach((input) => {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    });
  }
  function openRuntime() {
    runtimeBase = wizardState;
    runtimeGeneration = ++importGeneration;
    for (const input of runtimeDialog.querySelectorAll(
      "input,textarea,select",
    )) {
      if (input.type === "checkbox") input.checked = false;
      else input.value = "";
    }
    collectionElement("runtimeSQL").hidden = true;
    collectionElement("runtimeSQL").textContent = "";
    collectionElement("copyRuntimeSQL").hidden = true;
    collectionElement("runtimeCopyStatus").textContent = "";
    clearRuntimeError();
    collectionElement("saveRuntime").disabled =
      runtimeBase.bundle?.runtime?.samples !== undefined;
    runtimeDialog.showModal();
    if (collectionElement("saveRuntime").disabled)
      runtimeError(
        "This bundle contains authoritative runtime samples. Edit them in the comparison workflow; this editor cannot replace them.",
      );
    else collectionElement("runtimeQueryId").focus();
  }
  function closeRuntime() {
    ++importGeneration;
    runtimeBase = null;
    for (const input of runtimeDialog.querySelectorAll(
      "input,textarea,select",
    )) {
      if (input.type === "checkbox") input.checked = false;
      else input.value = "";
    }
    collectionElement("runtimeSQL").textContent = "";
    runtimeDialog.close();
    document.querySelector("[data-open-runtime]")?.focus();
  }
  collectionElement("closeRuntime").addEventListener("click", closeRuntime);
  runtimeDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeRuntime();
  });
  for (const id of [
    "runtimeQueryId",
    "runtimeFrom",
    "runtimeTo",
    "runtimeApproved",
  ])
    collectionElement(id).addEventListener("input", () => {
      collectionElement("runtimeSQL").hidden = true;
      collectionElement("copyRuntimeSQL").hidden = true;
      collectionElement("runtimeSQL").textContent = "";
    });
  collectionElement("prepareRuntimeSQL").addEventListener("click", () => {
    clearRuntimeError();
    if (!collectionElement("runtimeApproved").checked) {
      runtimeError(
        "Confirm permission to read metrics for this completed run before preparing SQL.",
        "runtimeApproved",
      );
      return;
    }
    try {
      collectionElement("runtimeSQL").textContent = runtimeSQL(
        collectionElement("runtimeQueryId").value,
        collectionElement("runtimeFrom").value,
        collectionElement("runtimeTo").value,
      );
      collectionElement("runtimeSQL").hidden = false;
      collectionElement("copyRuntimeSQL").hidden = false;
    } catch (error) {
      runtimeError(
        error.message,
        collectionElement("runtimeQueryId").value.trim()
          ? "runtimeFrom"
          : "runtimeQueryId",
      );
    }
  });
  collectionElement("copyRuntimeSQL").addEventListener("click", () =>
    copyCollectionText(
      collectionElement("runtimeSQL"),
      collectionElement("runtimeCopyStatus"),
    ),
  );
  collectionElement("saveRuntime").addEventListener("click", async () => {
    clearRuntimeError();
    if (runtimeBase !== wizardState || runtimeGeneration !== importGeneration) {
      runtimeError(
        "The analysis changed while this editor was open. Cancel and reopen it to associate the correct run.",
      );
      return;
    }
    let bundle;
    let metrics;
    try {
      metrics = runtimeInput(collectionElement("runtimeResult").value);
    } catch (error) {
      runtimeError(error.message);
      return;
    }
    try {
      bundle = mergeManualRuntime(bundleFromWizard(runtimeBase), metrics, {
        associated: collectionElement("runtimeAssociated").checked,
        successful: collectionElement("runtimeSuccessful").checked,
        scope: collectionElement("runtimeScope").value,
        source: collectionElement("runtimeSource").value,
      });
    } catch (error) {
      runtimeError(
        error.message,
        collectionElement("runtimeAssociated").checked
          ? "runtimeResult"
          : "runtimeAssociated",
      );
      return;
    }
    const generation = ++importGeneration;
    runtimeGeneration = generation;
    collectionElement("saveRuntime").disabled = true;
    const result = await controller.importState(
      wizardFromBundle(bundle),
      generation,
    );
    if (generation !== importGeneration) return;
    collectionElement("saveRuntime").disabled = false;
    if (!result) {
      runtimeError(
        "Could not apply these metrics. Your previous analysis and this draft are retained.",
      );
      return;
    }
    window.renderBundleMetadata?.(bundle);
    showView("costs");
    closeRuntime();
  });

  function showWizard(navigate = true, prefill = null) {
    ++importGeneration;
    if (prefill) suspendedWizard = null;
    wizardReturn = personalState ? "results" : "home";
    wizardDraft = structuredClone(
      prefill ? emptyState : suspendedWizard?.draft || personalState || emptyState,
    );
    if (wizardDraft.explainPlan && !wizardDraft.explainPlanQuery)
      wizardDraft.explainPlanQuery = wizardDraft.originalQuery;
    document.getElementById("replaceQueryEvidence").checked = false;
    document.getElementById("staleEvidenceNotice").hidden = true;
    document.getElementById("collectionCopyStatus").textContent = "";
    for (const [id, key] of [
      ["analysisName", "analysisName"],
      ["reviewQuestion", "reviewQuestion"],
      ["originalQuery", "originalQuery"],
      ["explainResult", "explainPlan"],
      ["estimateResult", "explainEstimate"],
      ["serverVersion", "serverVersion"],
      ["cloudMode", "cloudMode"],
      ["changedSettings", "changedSettings"],
    ]) {
      document.getElementById(id).value =
        suspendedWizard?.fields[id] ?? wizardDraft[key] ?? "";
    }
    document.getElementById("replaceQueryEvidence").checked =
      suspendedWizard?.replace || false;
    document.getElementById('analyzeResult').value = suspendedWizard?.fields.analyzeResult ?? wizardDraft.bundle?.explain?.analyze?.text ?? '';
    document.getElementById('analyzeAssociated').checked = suspendedWizard?.analyzeAssociated ?? Boolean(wizardDraft.bundle?.explain?.analyze?.association && wizardDraft.bundle.explain.analyze.sql === wizardDraft.originalQuery);
    setPageView("wizard", navigate !== false);
    clearWizardError();
    document.getElementById("queryWizard").hidden = false;
    document.getElementById("closeButton").textContent =
      wizardReturn === "results" ? "Back to analysis" : "Back to home";
    refreshManualWorkspace();
    loadSettingsData().catch((error) =>
      console.error("Failed to load settings catalog:", error),
    );
    document.getElementById("manualTitle").focus();
    if (prefill) {
      const field = document.getElementById(prefill.field);
      field.value = prefill.text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      if (prefill.field === 'estimateResult') field.closest('details').open = true;
      document.getElementById('collectionCopyStatus').textContent = prefill.status;
      document.getElementById('originalQuery').focus();
      window.scrollTo(0, 0);
    }
  }

  function closeWizard() {
    wizardDraft = null;
    document.getElementById("queryWizard").hidden = true;
  }

  function cancelWizard(event) {
    event?.preventDefault();
    ++importGeneration;
    suspendWizard();
    closeWizard();
    if (wizardReturn === "results" && !activeDemo) setPageView("results");
    else if (wizardReturn === "results") resumeResults();
    else showHome();
    document.getElementById("startAnalysis").focus();
  }

  function clearWizardError() {
    document.getElementById("wizardError").hidden = true;
    document
      .querySelectorAll("#queryWizard [aria-invalid]")
      .forEach((input) => {
        input.removeAttribute("aria-invalid");
        input.removeAttribute("aria-describedby");
      });
  }

  function showWizardError(message, inputId) {
    const error = document.getElementById("wizardError");
    error.textContent = message;
    error.hidden = false;
    const input = document.getElementById(inputId);
    input.closest("details.manual-optional")?.setAttribute("open", "");
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", "wizardError");
    input.focus();
  }

  function refreshManualWorkspace() {
    if (!wizardDraft) return;
    const sql = document.getElementById("originalQuery").value;
    const plan = document.getElementById("explainResult").value;
    const associatedSQL =
      wizardDraft.explainPlanQuery ||
      (wizardDraft.explainPlan ? wizardDraft.originalQuery : "");
    const changed = Boolean(associatedSQL && sql !== associatedSQL);
    document.getElementById("staleEvidenceNotice").hidden = !changed;
    document.getElementById("explainResult").disabled = changed;
    let sqlValid = false;
    try {
      const commands = collectionSQL(sql);
      for (const [id, key] of [
        ["explainQuery", "plan"],
        ["estimateQuery", "estimate"],
        ["pipelineSQL", "pipeline"],
      ])
        document.getElementById(id).textContent = commands[key];
      sqlValid = true;
      document.getElementById("manualSqlStatus").textContent =
        "Valid SQL. Collection commands are ready.";
    } catch (error) {
      for (const id of ["explainQuery", "estimateQuery", "pipelineSQL"])
        document.getElementById(id).textContent =
          "Enter valid SELECT or WITH SQL to generate this command.";
      document.getElementById("manualSqlStatus").textContent = error.message;
    }
    for (const id of ["copyExplainButton", "copyEstimateButton"])
      document.getElementById(id).disabled = !sqlValid;
    document
      .querySelectorAll("#queryWizard [data-copy-collection]")
      .forEach((button) => {
        button.disabled =
          !sqlValid && button.dataset.copyCollection === "pipelineSQL";
      });
    const ready = sqlValid && !changed && plan.trim();
    document.getElementById("visualizeButton").disabled = !ready;
    document.getElementById("manualReadiness").textContent = changed
      ? "Clear evidence tied to the previous SQL before adding a new plan."
      : ready
        ? "Required evidence is ready to validate."
        : sqlValid
          ? "Paste the query plan to continue."
          : "Add valid original SQL to generate collection commands.";
  }

  async function submitManualEntry() {
    const draft = structuredClone(wizardDraft);
    clearWizardError();
    try {
      collectionSQL(document.getElementById("originalQuery").value);
    } catch (error) {
      showWizardError(error.message, "originalQuery");
      return;
    }
    if (
      draft.explainPlanQuery &&
      document.getElementById("originalQuery").value !== draft.explainPlanQuery
    ) {
      showWizardError(
        "Clear evidence tied to the previous SQL before adding a new plan.",
        "replaceQueryEvidence",
      );
      return;
    }
    try {
      planInput(document.getElementById("explainResult").value);
    } catch (error) {
      showWizardError(error.message, "explainResult");
      return;
    }
    let normalizedEstimate;
    try {
      normalizedEstimate = rowInput(
        document.getElementById("estimateResult").value,
        "estimate",
      )
        .map((row) => JSON.stringify(row))
        .join("\n");
    } catch (error) {
      showWizardError(error.message, "estimateResult");
      return;
    }
    const analysisName = document.getElementById("analysisName").value;
    const reviewQuestion = document.getElementById("reviewQuestion").value;
    draft.analysisName = analysisName.trim() ? analysisName : "";
    draft.reviewQuestion = reviewQuestion.trim() ? reviewQuestion : "";
    draft.originalQuery = document.getElementById("originalQuery").value;
    draft.explainPlan = document.getElementById("explainResult").value;
    draft.explainPlanQuery = draft.originalQuery;
    draft.explainEstimate = normalizedEstimate;
    draft.serverVersion = document.getElementById("serverVersion").value.trim();
    draft.cloudMode = document.getElementById("cloudMode").value;
    draft.changedSettings = document
      .getElementById("changedSettings")
      .value.trim();
    if (
      draft.serverVersion &&
      !/^\d+\.\d+(?:\.[\w.-]+)?$/.test(draft.serverVersion)
    ) {
      showWizardError(
        "Paste the single version value, such as 26.8.2.7, or leave it empty.",
        "serverVersion",
      );
      return;
    }
    let changed;
    try {
      changed = rowInput(draft.changedSettings, "settings");
    } catch (error) {
      showWizardError(error.message, "changedSettings");
      return;
    }
    const cloudMode =
      draft.cloudMode === "" ? undefined : Number(draft.cloudMode);
    draft.bundle ||= {};
    const analyzeText = document.getElementById('analyzeResult').value.trim().replaceAll('\r\n', '\n');
    if (analyzeText) {
      if (!document.getElementById('analyzeAssociated').checked) {
        showWizardError('Confirm that ANALYZE belongs to an approved execution of this SQL with the same settings and schema.', 'analyzeAssociated');
        return;
      }
      try { parseAnalyze(analyzeText); }
      catch (error) { showWizardError(error.message, 'analyzeResult'); return; }
      draft.bundle.explain = { ...draft.bundle.explain, analyze: { text: analyzeText, sql: draft.originalQuery, association: 'user_attested' } };
    } else if (draft.bundle.explain) delete draft.bundle.explain.analyze;
    if (
      draft.bundle.clickhouse ||
      draft.serverVersion ||
      cloudMode !== undefined
    ) {
      const server = { ...draft.bundle.clickhouse };
      delete server.version;
      delete server.cloud;
      delete server.cloud_mode;
      if (draft.serverVersion) server.version = draft.serverVersion;
      if (cloudMode !== undefined) {
        server.cloud_mode = cloudMode;
        server.cloud = cloudMode === 1;
      }
      draft.bundle.clickhouse = server;
    }
    if (draft.bundle.settings || changed.length)
      draft.bundle.settings = { ...draft.bundle.settings, changed };
    const generation = ++importGeneration;
    try {
      const rendered = await processInput(generation, structuredClone(draft));
      if (generation !== importGeneration) return;
      if (rendered === null) return;
      if (rendered) {
        document.getElementById("estimateResult").value = normalizedEstimate;
        suspendedWizard = null;
        closeWizard();
        setPageView("results", false);
        window.renderBundleMetadata?.(wizardState.bundle || {});
        window.scrollToWorkspace?.();
      } else {
        showWizardError(
          "Could not render this evidence. Your previous analysis is unchanged. Review the plan and scan estimates, then retry.",
          "explainResult",
        );
      }
    } catch (error) {
      if (generation !== importGeneration) return;
      showWizardError(
        "Could not process this evidence. Your draft is retained. Review the plan and scan estimates.",
        "explainResult",
      );
    }
  }

  function copyExplainQuery() {
    return copyCollectionText(
      document.getElementById("explainQuery"),
      document.getElementById("collectionCopyStatus"),
    );
  }

  function copyEstimateQuery() {
    return copyCollectionText(
      document.getElementById("estimateQuery"),
      document.getElementById("collectionCopyStatus"),
    );
  }

  document
    .getElementById("closeButton")
    .addEventListener("click", cancelWizard);
  document
    .getElementById("visualizeButton")
    .addEventListener("click", submitManualEntry);
  document
    .getElementById("copyExplainButton")
    .addEventListener("click", copyExplainQuery);
  document
    .getElementById("copyEstimateButton")
    .addEventListener("click", copyEstimateQuery);
  // Other diagram panels consume the shared controls without touching D3 map state.
  function dispatchViewControl(action, detail = {}) {
    const view = document.querySelector('.canvas-body').dataset.activeView || 'river';
    if (view === 'river') return false;
    document.dispatchEvent(new CustomEvent('chquery:view-control', { detail: { view, action, ...detail } }));
    return true;
  }
  document.getElementById("fitGraphButton").addEventListener("click", () => {
    if (dispatchViewControl('fit')) return;
    if (!currentLayout) return;
    fitted = true;
    currentFitTransform = getFitTransform(currentLayout);
    applyGraphTransform(currentFitTransform, 450);
  });
  for (const [id, factor] of [['zoomOutButton', 0.8], ['zoomInButton', 1.25]])
    document.getElementById(id).addEventListener('click', () => {
      if (dispatchViewControl('zoom', { factor }) || !currentLayout) return;
      fitted = false;
      svg.call(zoom.scaleBy, factor);
    });

  function formatRecommendations(analysis) {
    const dispositions = review.snapshot();
    const candidates = selectCandidates(analysis.issues, dispositions);
    document.getElementById("includeReviewReport").checked = Boolean(includeReviewReport);
    const groups = groupFindings(analysis.issues);
    const observations = analysis.issues.filter(
      (i) =>
        i.classification === "observation" && !dispositions[i.occurrenceId],
    );
    const reviewed = analysis.issues.filter(
      (i) => dispositions[i.occurrenceId],
    );
    document.querySelector("#findings h2").textContent = 'Worth a look';
    const renderGroupControls = (group) => {
      const states = [
        ...new Set(group.occurrenceIds.map((id) => dispositions[id] || "open")),
      ];
      const state =
        states.length === 1
          ? states[0].replace("-", " ")
          : `mixed: ${states.map((value) => value.replace("-", " ")).join(", ")}`;
      return `<article class="finding-group-review" data-finding-group data-group-id="${escapeHtml(group.groupId)}">
          <div><b>${escapeHtml(group.message)}</b><span>${group.count} occurrence${group.count === 1 ? "" : "s"} · ${escapeHtml(state)}</span></div>
          <div class="review-controls"><button class="compact-button" type="button" data-group-review="intentional">Mark group intentional</button><button class="compact-button" type="button" data-group-review="not-relevant">Mark group not relevant</button>${groupUndo.has(group.groupId) ? '<button class="compact-button" type="button" data-group-undo>Undo group change</button>' : ""}${states.some((value) => value !== "open") ? '<button class="compact-button" type="button" data-group-restore>Restore all</button>' : ""}</div>
        </article>`;
    };
    const renderCards = (issues) =>
      issues
        .map(
          (issue) => `
        <article class="issue finding-card ${issue.classification}" data-finding-id="${escapeHtml(issue.id)}" data-node-id="${issue.nodeId || ""}" data-occurrence="${escapeHtml(issue.occurrenceId)}" tabindex="-1">
          <div class="finding-number">${String(analysis.issues.indexOf(issue) + 1).padStart(2, "0")}</div>
          <div class="finding-body">
            <div class="message">${escapeHtml(observationText(issue))}</div>
            ${issue.nodeIds.length ? `<button type="button" class="highlight-node" aria-label="Inspect evidence" onclick='highlightNodes(${JSON.stringify(issue.nodeIds)})'>${escapeHtml(issue.evidenceScope.nodes.map(node => `${node.nodeType} · ${node.table || node.nodeId}`).join(", "))} →</button>` : '<p class="finding-confidence">Query-level evidence · plan attribution unknown</p>'}
            <details class="finding-why"><summary>Why · ${escapeHtml(issue.confidence)} observation confidence</summary><p>${escapeHtml(issue.why)}</p><p>${escapeHtml(issue.priorityReason)}</p><dl class="finding-evidence">${issue.evidence.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>${issue.confirmationCheck ? `<p><b>Supporting check:</b> ${escapeHtml(issue.confirmationCheck.supporting)}</p><p><b>Weakening check:</b> ${escapeHtml(issue.confirmationCheck.weakening)}</p><p>${escapeHtml(issue.confirmationCheck.limitation)}</p>` : ""}</details>
            <div class="recommendation"><span>One thing to try —</span>${escapeHtml(issue.recommendation)} <small class="finding-confidence">${escapeHtml(issue.confidence)}</small></div>
            ${reviewControls(issue)}
          </div>
        </article>
      `,
        )
        .join("");

    return `
        <div class="recommendations-panel">
          <details class="grouped-review"><summary>Review finding groups (${groups.length})</summary><p>Review applies to this investigation only. Reload or changed evidence resets it. Bundle exports and share links do not include these judgments.</p><p>Group changes affect only matching occurrences in this investigation. Undo restores each occurrence’s prior judgment, including mixed states.</p><div class="finding-group-list">${groups.map(renderGroupControls).join("")}</div></details>
          ${!candidates.length ? '<p class="no-issues">No open checks.</p>' : ""}
          <div class="findings-grid actionable-findings">${renderCards(candidates)}</div>
          ${observations.length ? `<details class="observation-findings"><summary>Other observations &amp; settings context (${observations.length})</summary><div class="findings-grid">${renderCards(observations)}</div></details>` : ""}
          ${reviewed.length ? `<details class="reviewed-findings"><summary>Reviewed (${reviewed.length})</summary><p>User judgments, not evidence that a concern is fixed.</p><div class="findings-grid">${renderCards(reviewed)}</div></details>` : ""}
          <button class="text-button" type="button" data-clear-review>Start new investigation review</button>
          <p id="reviewStatus" role="status" aria-live="polite"></p>
        </div>
      `;
  }

  function reviewControls(issue) {
    const status = review.snapshot()[issue.occurrenceId];
    const actions = status
      ? [["open", "Restore"]]
      : [
          ["intentional", "Intentional"],
          ["not-relevant", "Not relevant"],
        ];
    return `<details class="finding-menu"><summary aria-label="Finding actions">⋯</summary><div class="review-controls">${status ? `<span>Reviewed: ${escapeHtml(status.replace("-", " "))}</span>` : ""}${actions.map(([value, label]) => `<button class="compact-button" type="button" data-review="${value}" data-occurrence="${escapeHtml(issue.occurrenceId)}">${label}</button>`).join("")}${!status && issue.eligible ? `<button type="button" class="text-button" data-investigate="${escapeHtml(issue.occurrenceId)}">Investigate this instead</button>` : ""}</div></details>`;
  }

  document.addEventListener("change", async (event) => {
    if (event.target.id === "runtimeGroup" && !activeDemo) {
      const analysis = window.currentAnalysis;
      const generation = importGeneration;
      const selectedGroup =
        event.target.value === ""
          ? null
          : analysis.measurements.groups[Number(event.target.value)].key;
      event.target.disabled = true;
      try {
        const prepared = await prepareRuntime(
          wizardState.bundle,
          analysis.coverage,
          { selectedGroup },
        );
        if (
          generation !== importGeneration ||
          analysis !== window.currentAnalysis
        )
          return;
        personalMeasurementGroup = selectedGroup;
        Object.assign(analysis, prepared);
        renderEvidenceViews(currentRoot.data, analysis);
        renderAnalysisSummary(analysis);
        document.getElementById("runtimeGroup")?.focus({ preventScroll: true });
      } catch (error) {
        if (generation !== importGeneration) return;
        event.target.disabled = false;
        document.getElementById("summaryStatus").textContent = error.message;
      }
    }
    if (event.target.id === "includeReviewReport") {
      includeReviewReport = event.target.checked;
      if (!activeDemo) personalReportOption = includeReviewReport;
    }
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest(
      "[data-review], [data-clear-review], [data-group-review], [data-group-undo], [data-group-restore]",
    );
    if (!button || !window.currentAnalysis) return;
    const occurrence = button.dataset.occurrence;
    const inInspector = Boolean(button.closest("#nodeInspector"));
    let statusText;
    const groupElement = button.closest("[data-finding-group]");
    const group =
      groupElement &&
      groupFindings(window.currentAnalysis.issues).find(
        (item) => item.groupId === groupElement.dataset.groupId,
      );
    if (button.hasAttribute("data-clear-review")) {
      review.clear();
      review.publish(wizardState.bundle);
      includeReviewReport = false;
      groupUndo.clear();
      statusText = "New investigation review started. All judgments cleared.";
    } else if (button.hasAttribute("data-group-review")) {
      groupUndo.set(
        group.groupId,
        review.setGroup(group, button.dataset.groupReview),
      );
      statusText = `Group marked ${button.dataset.groupReview.replace("-", " ")}. ${group.count} matching occurrences updated.`;
    } else if (button.hasAttribute("data-group-undo")) {
      review.undoGroup(groupUndo.get(group.groupId));
      groupUndo.delete(group.groupId);
      statusText =
        "Group change undone. Each prior occurrence judgment was restored.";
    } else if (button.hasAttribute("data-group-restore")) {
      review.restoreGroup(group);
      groupUndo.delete(group.groupId);
      statusText = `All ${group.count} matching occurrences restored to open.`;
    } else {
      review.set(occurrence, button.dataset.review);
      for (const [id, token] of groupUndo)
        if (token.occurrenceIds.includes(occurrence)) groupUndo.delete(id);
      statusText = `Finding ${button.dataset.review === "open" ? "restored" : `marked ${button.dataset.review.replace("-", " ")}`}. Analysis evidence is unchanged.`;
    }
    if (!activeDemo) personalReportOption = includeReviewReport;
    const analysis = window.currentAnalysis;
    analysis.candidates = selectCandidates(analysis.issues, review.snapshot());
    analysis.brief = briefFromBundle(wizardState.bundle, {
      reviewDispositions: review.snapshot(),
    });
    renderAnalysisSummary(analysis);
    document.getElementById("recommendationsSlot").innerHTML =
      formatRecommendations(analysis);
    renderInspector(inspectedNode);
    render(currentRoot);
    document.getElementById("reviewStatus").textContent = statusText;
    const target = [
      ...document.querySelectorAll(
        inInspector ? "#nodeInspector [data-occurrence]" : ".finding-card",
      ),
    ].find((element) => element.dataset.occurrence === occurrence);
    const disclosure = target?.closest(
      ".reviewed-findings, .observation-findings",
    );
    if (disclosure) disclosure.open = true;
    const groupTarget =
      group &&
      [...document.querySelectorAll("[data-finding-group]")].find(
        (element) => element.dataset.groupId === group.groupId,
      );
    if (groupTarget) groupTarget.closest("details").open = true;
    if (inInspector && target) target.closest(".finding-menu").open = true;
    (
      target ||
      groupTarget?.querySelector("button") ||
      document.querySelector("[data-clear-review]")
    ).focus({ preventScroll: true });
  });

  // Update the highlight node function to maintain consistent zoom
  window.highlightNodes = function (nodeIds) {
    if (!currentRoot) return;
    showView("river");
    const ids = new Set(Array.isArray(nodeIds) ? nodeIds : [nodeIds]);
    const selectedNode = allNodes.find((node) => ids.has(node.data.nodeId));
    if (selectedNode) {
      currentLayout
        .descendants()
        .filter((node) =>
          node.grouped?.some((member) => ids.has(member.data.nodeId)),
        )
        .forEach((node) => expandedChains.add(node.data.nodeId));
      render(currentRoot);
      selectGraphNode(selectedNode, { focus: true, inspect: true });
      d3.selectAll(".node").classed("highlighted", (node) =>
        (node.grouped || [node]).some((member) => ids.has(member.data.nodeId)),
      );
      d3.selectAll(".stage-step").classed("highlighted-step", (node) =>
        ids.has(node.data.nodeId),
      );
      document.querySelector(".node.selected")?.focus({ preventScroll: true });
      window.scrollToWorkspace?.(true);
    }
  };

  // Compatibility for existing feature modules and local snapshot windows.
  window.chqueryWizard = controller;
  return controller;
}
