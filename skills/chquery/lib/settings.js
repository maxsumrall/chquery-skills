import { flattenPlan } from "./model.js";

function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function catalogVersion(version) {
  const match = String(version || "").match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : null;
}

function effectiveDefault(setting, version) {
  let effective;
  for (const entry of setting.default_by_version || []) {
    if (compareVersions(entry.version, version) <= 0) effective = entry.value;
  }
  return effective;
}

function concernFor(name, concerns) {
  if (Object.hasOwn(concerns, name)) return concerns[name];
  const wildcard = Object.entries(concerns).find(([pattern]) =>
    pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))
  );
  return wildcard?.[1];
}

function recommendationCondition(value) {
  return value ? `${value[0].toLowerCase()}${value.slice(1)}` : "only after measuring the affected workload.";
}

function affectedNodes(plan, concern) {
  if (!plan || !concern) return [];
  return flattenPlan(plan, []).filter(node => concern.affects.includes(node.kind));
}

function isCloudMode(cloudMode, schema) {
  return Number(cloudMode) === 1 || (schema || []).some(table => /SharedMergeTree/i.test(table.engine || table.ddl || ""));
}

function settingFinding({ id, severity = "low", confidence = "high", setting, current, defaultForVersion, changedInVersion, why, nodes, message, recommendation }) {
  const nodeIds = nodes.map(node => node.nodeId);
  const settingEvidence = {
    setting,
    current: current ?? "Not set",
    default_for_version: defaultForVersion ?? "Unknown",
    changed_in_version: changedInVersion ?? "Not applicable",
    why
  };
  return {
    id,
    severity,
    confidence,
    evidence: Object.entries(settingEvidence)
      .filter(([label]) => label !== "why")
      .map(([label, value]) => [label.replaceAll("_", " "), String(value)]),
    settingEvidence,
    nodeIds,
    type: id,
    message,
    why,
    recommendation,
    nodeId: nodeIds[0]
  };
}

export function analyzeSettings({ version, cloud_mode, changed = [], plan, catalog = {}, concerns = {}, schema = [] } = {}) {
  const versions = catalog.versions || [];
  const normalizedVersion = catalogVersion(version);
  const versionIndex = normalizedVersion ? versions.indexOf(normalizedVersion) : -1;
  const versionKnown = versionIndex >= 0;
  const cloud = isCloudMode(cloud_mode, schema);
  const effectiveDefaults = {};
  const relevantChanged = [];
  const newerDefaults = [];
  const obsoleteChanged = [];
  const findings = [];
  const hidden = [];
  const changedByName = new Map((changed || []).filter(item => item?.name).map(item => [item.name, item]));

  if (versionKnown) {
    for (const [name, setting] of Object.entries(catalog.settings || {})) {
      effectiveDefaults[name] = effectiveDefault(setting, normalizedVersion);
    }
  }

  for (const changedSetting of changed || []) {
    if (!changedSetting?.name) continue;
    const setting = Object.hasOwn(catalog.settings || {}, changedSetting.name) ? catalog.settings[changedSetting.name] : undefined;
    const concern = concernFor(changedSetting.name, concerns);
    const nodes = affectedNodes(plan, concern);
    const defaultForVersion = versionKnown
      ? (Object.hasOwn(effectiveDefaults, changedSetting.name) ? effectiveDefaults[changedSetting.name] : undefined)
      : changedSetting.default;
    if (setting?.obsolete) {
      obsoleteChanged.push(changedSetting);
      findings.push(settingFinding({
        id: "setting_obsolete", severity: "medium", setting: changedSetting.name,
        current: changedSetting.value, defaultForVersion,
        why: `${changedSetting.name} is marked obsolete in the ClickHouse settings catalog, so this override may no longer control the active code path and can conceal the supported replacement.`,
        nodes: nodes.length ? nodes : [plan].filter(Boolean),
        message: `${changedSetting.name} is obsolete but still set`,
        recommendation: "Remove the obsolete override after checking the catalog description and release notes for its replacement."
      }));
    }
    if (!concern || !nodes.length) continue;
    if (cloud && concern.cloud === "hide") {
      hidden.push(changedSetting.name);
      continue;
    }
    if (!cloud && concern.cloud === "only") continue;
    relevantChanged.push({ ...changedSetting, concern, nodeIds: nodes.map(node => node.nodeId) });
    findings.push(settingFinding({
      id: "setting_changed_relevant", setting: changedSetting.name, current: changedSetting.value,
      defaultForVersion,
      why: `${changedSetting.name} is reported as ${changedSetting.value}${defaultForVersion === undefined ? "" : `; its ${normalizedVersion || "reported"} catalog default is ${defaultForVersion}`}. ${concern.direction} ${concern.note}`,
      nodes,
      message: `${changedSetting.name} touches this plan`, recommendation: `Revisit this setting ${recommendationCondition(concern.when_to_suggest)}`
    }));
  }

  if (versionKnown) {
    for (const [name, setting] of Object.entries(catalog.settings || {})) {
      const concern = concernFor(name, concerns);
      const nodes = affectedNodes(plan, concern);
      if (!concern || !nodes.length || (cloud && concern.cloud === "hide") || (!cloud && concern.cloud === "only")) continue;
      for (const future of (setting.default_by_version || []).filter(entry => compareVersions(entry.version, normalizedVersion) > 0)) {
        const item = { name, current: effectiveDefaults[name], ...future, nodeIds: nodes.map(node => node.nodeId) };
        newerDefaults.push(item);
        findings.push(settingFinding({
          id: "default_moved_since_version", setting: name, current: effectiveDefaults[name],
          defaultForVersion: effectiveDefaults[name], changedInVersion: future.version,
          why: `${name} defaults to ${effectiveDefaults[name]} on ${normalizedVersion}, but ClickHouse changes it to ${future.value} in ${future.version}. ${concern.direction}`,
          nodes,
          message: `${name} changes after ClickHouse ${normalizedVersion}`,
          recommendation: `Test the ${future.version} default (${future.value}) before upgrading; do not pin it without workload evidence.`
        }));
      }
    }
  }

  if (hidden.length) {
    const nodes = flattenPlan(plan, []).filter(node => ["Table scan", "Aggregation", "Sort", "Join"].includes(node.kind));
    findings.push(settingFinding({
      id: "cloud_self_hosted_advice_hidden", setting: hidden.join(", "), current: "Hidden in Cloud mode",
      why: `ClickHouse Cloud sizes or controls ${hidden.join(", ")} at the service level, so self-hosted tuning advice for these overrides does not map directly to this deployment.`,
      nodes,
      message: "Self-hosted settings advice is hidden for ClickHouse Cloud",
      recommendation: "Use Cloud service sizing, parallel replicas, and remote-read cache evidence instead of self-hosted thread or cache-path tuning."
    }));
  }

  if (cloud) {
    for (const name of ["max_parallel_replicas", "enable_filesystem_cache"]) {
      if (changedByName.has(name)) continue;
      const concern = concerns[name];
      const nodes = affectedNodes(plan, concern);
      if (!concern || !nodes.length) continue;
      findings.push(settingFinding({
        id: "cloud_plan_relevant", setting: name,
        current: versionKnown ? effectiveDefaults[name] : "Not reported",
        defaultForVersion: versionKnown ? effectiveDefaults[name] : undefined,
        why: `${name} applies to the table-scan stages in this Cloud plan. ${concern.direction} ${concern.note}`,
        nodes,
        message: `${name} is relevant to this Cloud scan`,
        recommendation: `Test this setting ${recommendationCondition(concern.when_to_suggest)}`
      }));
    }
  }

  return {
    version: version || null,
    normalizedVersion,
    versionKnown,
    versionIndex,
    versionCount: versions.length,
    versionNote: versionKnown ? `${normalizedVersion} is ${versionIndex + 1} of ${versions.length} catalog versions.` : "Unknown version; version-relative default advice was skipped.",
    cloud,
    effectiveDefaults,
    relevantChanged,
    newerDefaults,
    obsoleteChanged,
    findings
  };
}
