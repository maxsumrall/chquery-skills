import {
  bundleFromWizard,
  validateBundle,
  wizardFromBundle,
} from "./bundle.js";
import { prepareBundleForReview } from "./comparison-report.js";
import { bundleToMarkdown } from "./report.js";
import { decodeBundle, encodeShareJson } from "./share.js";
import {
  assertComparisonEvidence,
  parseComparisonEvidence,
  COMPARISON_LIMITS,
} from "./comparison-artifact.js";
import {
  createStoredShare,
  loadStoredShare,
  getStoredShareConfig,
  deleteStoredShare,
  validateDeletionReceipt,
} from "./stored-share.js";

export async function initInterchangeUI(workspace) {
  const exportButton = document.getElementById("exportBundleButton");
  const reportButton = document.getElementById("copyMarkdownReportButton");
  const importButton = document.getElementById("importBundleButton");
  const importInput = document.getElementById("importBundleInput");
  const shareButton = document.getElementById("copyShareLinkButton");
  const includeLiteralValues = document.getElementById("includeLiteralValues");
  const identifierPrivacyMode = document.getElementById(
    "identifierPrivacyMode",
  );
  const shareStatus = document.getElementById("shareStatus");
  const agentPrompt = document.getElementById("agentPrompt");
  const copyAgentPrompt = document.getElementById("copyAgentPrompt");

  // W6 calls this only after the browser has authorized, decrypted and
  // validated a transfer. Keep the exact JSON in memory and open the normal
  // application workspace; never reconstruct a fragment or write storage.
  window.chqueryOpenTransferredArtifact = async ({ json } = {}) => {
    if (typeof json !== "string")
      throw new TypeError(
        "Transferred evidence must include its exact JSON text.",
      );
    const artifact = JSON.parse(json);
    if (artifact?.chquery === 1) {
      const validation = validateBundle(artifact);
      if (!validation.valid) {
        const error = new TypeError("Transferred query evidence is invalid.");
        error.errors = validation.errors;
        throw error;
      }
      if (
        workspace.hasPersonalWork() &&
        !confirm(
          "Open this transferred query review and replace the current personal workspace?",
        )
      )
        return false;
      const generation = workspace.beginImport();
      const opened = await openBundle(artifact, 'Analysis imported.', generation);
      if (opened) scrollToWorkspace();
      return opened;
    }
    if (artifact?.chquery_comparison === 1) {
      assertComparisonEvidence(artifact, { pair: true });
      const { openComparisonArtifact } = await import("./comparison-ui.js");
      return openComparisonArtifact(artifact, () => true);
    }
    if (artifact?.chquery_investigation === 1) {
      const { openInvestigationArtifact } = await import(
        "./investigation-ui.js"
      );
      return openInvestigationArtifact(json);
    }
    throw new TypeError(
      "Transferred evidence must be a CH Query analysis, comparison or investigation.",
    );
  };

  const storedDialog = document.getElementById("storedShareDialog");
  const storedStatus = document.getElementById("storedShareStatus");
  const storedCreate = document.getElementById("storedShareButton");
  const storedConsent = document.getElementById("storedShareConsent");
  const storedSuccess = document.getElementById("storedShareSuccess");
  const storedLink = document.getElementById("storedShareUrl");
  const deleteButton = document.getElementById("deleteStoredShare");
  let storedConfig = null;
  let storedBusy = false;
  let storedComparison = null;
  let deletionReceipt = null;
  let turnstileToken = "";
  let widgetId;
  let turnstileScript;

  function storedMessage(message, warning = false) {
    storedStatus.textContent = message;
    storedStatus.classList.toggle("warning", warning);
    document.getElementById("retryStoredShare").hidden =
      !warning && Boolean(storedConfig?.enabled);
  }
  function updateStoredCreate() {
    const stale = Boolean(storedComparison && !storedComparison.isCurrent());
    storedCreate.disabled =
      storedBusy ||
      !storedConfig?.enabled ||
      !storedConsent.checked ||
      Boolean(storedConfig.turnstileSiteKey && !turnstileToken) ||
      !storedSuccess.hidden ||
      stale;
    document.getElementById("storedShareLocalLink").disabled =
      storedBusy || stale;
    if (stale && storedSuccess.hidden && !storedBusy)
      storedMessage(
        "Comparison changed. Close this dialog and review the current comparison again before saving.",
        true,
      );
  }
  window.refreshStoredComparisonShare = updateStoredCreate;
  function resetChallenge() {
    turnstileToken = "";
    if (widgetId !== undefined) window.turnstile.reset(widgetId);
    updateStoredCreate();
  }
  async function loadChallenge(sitekey) {
    if (!turnstileScript) {
      turnstileScript = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src =
          "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        const timer = setTimeout(() => {
          script.remove();
          reject(
            new Error("Verification could not load. Retry or use Share link."),
          );
        }, 15000);
        script.onload = () => {
          clearTimeout(timer);
          resolve();
        };
        script.onerror = () => {
          clearTimeout(timer);
          script.remove();
          reject(
            new Error("Verification could not load. Retry or use Share link."),
          );
        };
        document.head.append(script);
      }).catch((error) => {
        turnstileScript = null;
        throw error;
      });
    }
    await turnstileScript;
    if (widgetId !== undefined) window.turnstile.remove(widgetId);
    widgetId = window.turnstile.render("#storedShareChallenge", {
      sitekey,
      action: "share-create",
      size: "flexible",
      callback: (token) => {
        turnstileToken = token;
        updateStoredCreate();
      },
      "expired-callback": () => {
        turnstileToken = "";
        updateStoredCreate();
      },
      "error-callback": () => {
        turnstileToken = "";
        updateStoredCreate();
        storedMessage("Verification failed. Retry or use Share link.", true);
      },
    });
  }
  async function refreshStoredConfig() {
    if (storedBusy || document.getElementById("retryStoredShare").disabled)
      return;
    storedConfig = null;
    turnstileToken = "";
    updateStoredCreate();
    storedMessage("Checking stored-share availability…");
    document.getElementById("retryStoredShare").disabled = true;
    try {
      storedConfig = await getStoredShareConfig();
      if (storedConfig.turnstileSiteKey && storedConfig.enabled)
        await loadChallenge(storedConfig.turnstileSiteKey);
      storedMessage(
        storedConfig.enabled
          ? "Nothing uploaded yet."
          : "Stored sharing is disabled. Use Share link or export; you can still delete existing links.",
        !storedConfig.enabled,
      );
    } catch (error) {
      storedConfig = null;
      storedMessage(error.message, true);
    } finally {
      document.getElementById("retryStoredShare").disabled = false;
      updateStoredCreate();
    }
  }
  function resetStoredShare() {
    if (
      deletionReceipt &&
      !window.confirm(
        "Save the current deletion receipt first if you want to delete that share later. Continue with a new link? The previous share will remain available until deleted or expired.",
      )
    )
      return false;
    deletionReceipt = null;
    storedSuccess.hidden = true;
    storedLink.value = "";
    deleteButton.hidden = true;
    storedConsent.checked = false;
    document.getElementById("storedShareSetup").hidden = false;
    document.querySelector(".stored-share-manage").hidden = false;
    return true;
  }
  const comparisonShareCopy = {
    storedShareTitle: "Save & share comparison",
    storedShareDescription:
      "Save both runs and the included comparison notes for 7 days. One link reopens the comparison, with no account or file download.",
    storedSharePreparation:
      "Your browser encrypts the exact comparison snapshot you reviewed before uploading it to Cloudflare R2. It does not apply redaction again.",
    storedShareConsentText:
      "Encrypt and upload this exact reviewed comparison snapshot for 7 days.",
    storedShareUrlLabel: "Your comparison link",
    copyStoredShare: "Copy comparison link",
  };
  const analysisShareCopy = Object.fromEntries(
    Object.keys(comparisonShareCopy).map((id) => [
      id,
      document.getElementById(id).textContent,
    ]),
  );
  function openStoredShare(comparison = null) {
    if (!storedBusy) {
      if (comparison?.json !== storedComparison?.json && !resetStoredShare()) {
        storedDialog.showModal();
        return;
      }
      storedComparison = comparison;
      for (const [id, text] of Object.entries(
        comparison ? comparisonShareCopy : analysisShareCopy,
      ))
        document.getElementById(id).textContent = text;
    }
    window.scrollTo({ top: window.scrollY, behavior: "instant" });
    storedDialog.showModal();
    if (storedSuccess.hidden) refreshStoredConfig();
  }
  window.openStoredComparisonShare = openStoredShare;
  document
    .getElementById("openStoredShare")
    .addEventListener("click", () => openStoredShare());
  document
    .getElementById("closeStoredShare")
    .addEventListener("click", () => storedDialog.close());
  document.getElementById("newStoredShare").addEventListener("click", () => {
    if (storedBusy || !resetStoredShare()) return;
    refreshStoredConfig();
    storedConsent.focus();
  });
  document
    .getElementById("retryStoredShare")
    .addEventListener("click", refreshStoredConfig);
  storedConsent.addEventListener("change", updateStoredCreate);
  storedCreate.addEventListener("click", async () => {
    updateStoredCreate();
    if (storedCreate.disabled) return;
    storedBusy = true;
    updateStoredCreate();
    storedMessage(
      storedComparison
        ? "Encrypting and uploading the exact reviewed comparison…"
        : "Applying standard redaction, compressing, encrypting and uploading…",
    );
    try {
      const result = await createStoredShare(
        storedComparison
          ? storedComparison.json
          : bundleFromWizard(workspace.getState()),
        turnstileToken,
      );
      deletionReceipt = { id: result.id, deleteToken: result.deleteToken };
      storedLink.value = result.href;
      document.getElementById("storedShareExpiry").textContent =
        `Expires ${new Date(result.expiresAt).toLocaleString()}. Anyone with this link can read it.`;
      storedSuccess.hidden = false;
      document.getElementById("storedShareSetup").hidden = true;
      document.querySelector(".stored-share-manage").hidden = true;
      deleteButton.hidden = false;
      document.getElementById("saveDeletionReceipt").hidden = false;
      storedMessage(
        `Saved for seven days. Copy your ${storedComparison ? "comparison" : "analysis"} link to reopen or share it.`,
      );
      document.getElementById("copyStoredShare").focus();
    } catch (error) {
      storedMessage(error.message, true);
    } finally {
      storedBusy = false;
      resetChallenge();
    }
  });
  document
    .getElementById("copyStoredShare")
    .addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(storedLink.value);
        storedMessage(
          storedComparison
            ? "Comparison link copied. Keep it to reopen both runs before it expires."
            : "Analysis link copied. Keep it to reopen the analysis before it expires.",
        );
      } catch {
        storedLink.focus();
        storedLink.select();
        storedMessage(
          "Clipboard unavailable. Copy the selected link manually.",
          true,
        );
      }
    });
  document
    .getElementById("saveDeletionReceipt")
    .addEventListener("click", () => {
      if (!deletionReceipt) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(deletionReceipt, null, 2)], {
          type: "application/json",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `chquery-delete-${deletionReceipt.id}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      storedMessage(
        "Deletion receipt download started. Keep it private; it can delete this share, but cannot read it.",
      );
    });
  document
    .getElementById("importDeletionReceipt")
    .addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        if (file.size > 4096) throw new Error("Deletion receipt is too large.");
        const receipt = validateDeletionReceipt(JSON.parse(await file.text()));
        deletionReceipt = receipt;
        deleteButton.hidden = false;
        storedMessage(
          `Receipt loaded for share ${receipt.id}. Choose Delete stored share to revoke it.`,
        );
      } catch {
        storedMessage(
          "Invalid deletion receipt. Choose the file saved when you created the link.",
          true,
        );
      } finally {
        event.target.value = "";
      }
    });
  deleteButton.addEventListener("click", async () => {
    if (
      !deletionReceipt ||
      !window.confirm(
        "Delete this stored share? Its link will stop working for everyone. This cannot be undone.",
      )
    )
      return;
    deleteButton.disabled = true;
    try {
      await deleteStoredShare(deletionReceipt);
      deletionReceipt = null;
      deleteButton.hidden = true;
      document.getElementById("saveDeletionReceipt").hidden = true;
      storedSuccess.hidden = true;
      document.getElementById("storedShareSetup").hidden = false;
      document.querySelector(".stored-share-manage").hidden = false;
      storedLink.value = "";
      storedConsent.checked = false;
      storedMessage(
        "Stored share deleted. Its link no longer works. Copies already downloaded are not removed.",
      );
    } catch (error) {
      storedMessage(error.message, true);
    } finally {
      deleteButton.disabled = false;
      updateStoredCreate();
    }
  });

  function renderBundleMetadata(bundle) {
    const clickhouse = bundle.clickhouse;
    const changed = Array.isArray(bundle.settings?.changed)
      ? bundle.settings.changed
      : [];
    const serverChip = document.getElementById("serverChip");
    const serverChipText = document.getElementById("serverChipText");
    const serverCard = document.getElementById("serverCard");
    const version = clickhouse?.version;
    const isCloud =
      clickhouse?.cloud === true || Number(clickhouse?.cloud_mode) === 1;
    const hasCloudMode =
      clickhouse && ("cloud" in clickhouse || "cloud_mode" in clickhouse);
    serverChip.hidden = false;
    serverChipText.textContent = `${version || "Unknown version"}${hasCloudMode ? ` · ${isCloud ? "Cloud" : "Self-hosted"}` : ""}`;

    const rows = [];
    if (version) rows.push(["Version", version]);
    if (clickhouse && ("cloud" in clickhouse || "cloud_mode" in clickhouse)) {
      rows.push(["Cloud", isCloud ? "Yes" : "No"]);
    }
    if (changed.length) {
      rows.push([
        "Changed settings",
        changed
          .map(
            (setting) =>
              `${setting.name}: ${setting.value}${setting.default !== undefined ? ` (default ${setting.default})` : ""}`,
          )
          .join("\n"),
      ]);
    }
    serverCard.innerHTML = rows.length
      ? `<dl>${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</dd></div>`).join("")}</dl>`
      : '<p class="empty-copy">No server information in this bundle.</p>';
  }
  window.renderBundleMetadata = renderBundleMetadata;

  function showBundleState(kind, message, retry) {
    document.body.dataset.page = "loading";
    const placeholder = document.getElementById("graphPlaceholder");
    placeholder.classList.toggle("error-state", kind === "error");
    placeholder.classList.toggle("loading-state", kind === "loading");
    placeholder.style.display = "grid";
    placeholder.querySelector(".graph-empty-card").innerHTML =
      kind === "loading"
        ? '<div class="state-spinner" aria-hidden="true"></div><h2>Loading bundle…</h2><p></p>'
        : '<div class="state-mark">!</div><h2>That link did not open.</h2><p></p>';
    placeholder.querySelector(".graph-empty-card p").textContent = message;
    placeholder.tabIndex = -1;
    placeholder.setAttribute("role", "status");
    if (retry) {
      const button = document.createElement("button");
      button.className = "compact-button";
      button.textContent = "Retry opening link";
      button.addEventListener("click", retry);
      placeholder.querySelector(".graph-empty-card").append(button);
    }
    if (kind === "error") placeholder.focus({ preventScroll: true });
    scrollToWorkspace(true);
  }

  copyAgentPrompt.addEventListener("click", async () => {
    const status = document.getElementById("agentCopyStatus");
    const label = copyAgentPrompt.querySelector("span");
    try {
      await navigator.clipboard.writeText(agentPrompt.textContent);
      label.textContent = "Copied";
      status.textContent = "Copied. Paste it into your agent.";
      setTimeout(() => {
        label.textContent = "Copy";
      }, 1500);
    } catch {
      agentPrompt.focus();
      const range = document.createRange();
      range.selectNodeContents(agentPrompt);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      status.textContent =
        "Clipboard unavailable. Copy the selected text manually.";
    }
  });

  const shareMenu = document.querySelector(".share-menu");
  document.addEventListener("click", (event) => {
    if (
      !shareMenu.open ||
      (shareMenu.contains(event.target) && !event.target.closest("button"))
    )
      return;
    shareMenu.open = false;
    if (shareMenu.contains(document.activeElement))
      shareMenu.querySelector("summary").focus();
  });
  shareMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      shareMenu.open = false;
      shareMenu.querySelector("summary").focus();
      event.preventDefault();
    }
  });

  exportButton.addEventListener("click", () => {
    const bundle = bundleFromWizard(workspace.getState());
    downloadBundle(bundle, "chquery-bundle.json");
  });

  function downloadBundle(bundle, filename) {
    const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  importButton.addEventListener("click", () => importInput.click());
  importInput.addEventListener("click", () => {
    importInput.value = "";
  });
  importInput.addEventListener("change", async () => {
    const files = [...importInput.files];
    if (!files.length) return;
    importInput.value = "";
    if (
      files.length === 1 &&
      workspace.hasPersonalWork() &&
      !confirm(
        "Replace your personal analysis and any in-progress draft with this bundle?",
      )
    )
      return;
    const generation = workspace.beginImport();

    try {
      if (
        files.length > 20 ||
        files.reduce((total, file) => total + file.size, 0) >
          COMPARISON_LIMITS.totalBytes
      ) {
        throw new RangeError(
          "Choose at most 20 files totaling at most 20 MiB. Nothing was read or replaced.",
        );
      }
      if (files.length > 1) {
        const sources = await Promise.all(
          files.map(async (file) => {
            const bundle = parseComparisonEvidence(await file.text());
            if (bundle.chquery !== 1)
              throw new TypeError(
                `${file.name} is not a standalone CH Query analysis.`,
              );
            return { name: file.name, bundle };
          }),
        );
        if (!workspace.isCurrentImport(generation)) return;
        const roles = await workspace.selectComparisonRoles(sources);
        if (!roles || !workspace.isCurrentImport(generation)) return;
        const pair = {
          chquery_comparison: 1,
          baseline: {
            bundle: sources[roles.baseline].bundle,
            label: sources[roles.baseline].name,
          },
          candidate: {
            bundle: sources[roles.candidate].bundle,
            label: sources[roles.candidate].name,
          },
          context: {},
        };
        if (await openBundle(pair, "Comparison files imported.", generation)) {
          scrollToWorkspace();
        }
        return;
      }
      // Preserve the legacy personal viewer's diagnostic inputs (including
      // malformed optional runtime). Formed pairs and outgoing preparation
      // still pass their owning canonical validators in openBundle/prepare.
      const bundle = JSON.parse(await files[0].text());
      if (await openBundle(bundle, "Bundle imported.", generation)) {
        scrollToWorkspace();
      }
    } catch (error) {
      if (!workspace.isCurrentImport(generation)) return;
      shareStatus.classList.add("warning");
      shareStatus.textContent =
        "Could not render this bundle. Previous evidence has been retained.";
      const details = error.errors
        ?.map((item) => `${item.path}: ${item.message}`)
        .join("\n");
      alert(`Could not import bundle.\n${details || error.message}`);
    }
  });

  includeLiteralValues.addEventListener("change", () => {
    shareStatus.classList.toggle("warning", includeLiteralValues.checked);
    shareStatus.textContent = includeLiteralValues.checked
      ? "Literal values will be included in the share link."
      : "Literal values are redacted before the link is created.";
  });
  identifierPrivacyMode.addEventListener("change", () => {
    shareStatus.classList.add("warning");
    shareStatus.textContent =
      identifierPrivacyMode.value === "pseudonymize"
        ? "Identifiers will share a fresh mapping across supported review surfaces. This is not anonymization; author text can remain identifying."
        : "Identifiers will remain visible in outgoing evidence. Review them before sharing.";
  });

  async function createShareLink(sourceBundle) {
    const reviewed = prepareBundleForReview(sourceBundle, {
      redact: !includeLiteralValues.checked,
      identifiers: identifierPrivacyMode.value,
    });
    const fragment = await encodeShareJson(reviewed.json);
    const url = new URL(window.location.href);
    url.hash = fragment.slice(1);
    workspace.renderPreparedBrief(reviewed.artifact);
    return {
      href: url.href,
      bundle: reviewed.artifact,
      summary:
        reviewed.artifact.redaction?.summary ||
        "Literal values included; redaction disabled",
      tooLong: url.href.length > 16 * 1024,
    };
  }

  reportButton.addEventListener("click", async () => {
    try {
      const sourceBundle = bundleFromWizard(workspace.getState());
      const reviewDispositions = workspace.includeReviewReport()
        ? workspace.getReviewDispositions()
        : undefined;
      const result = await createShareLink(sourceBundle);
      await navigator.clipboard.writeText(
        bundleToMarkdown(result.bundle, {
          link: result.href,
          reviewDispositions,
        }),
      );
      shareStatus.classList.toggle(
        "warning",
        result.tooLong || includeLiteralValues.checked,
      );
      shareStatus.textContent = `${result.summary}. Markdown report copied.${result.tooLong ? " This URL exceeds about 16 KB; export the bundle instead." : ""}`;
    } catch (error) {
      console.error("Could not create markdown report:", error);
      shareStatus.classList.add("warning");
      shareStatus.textContent = `Could not create markdown report: ${error.message}`;
    }
  });

  shareButton.addEventListener("click", async () => {
    try {
      const result = await createShareLink(
        bundleFromWizard(workspace.getState()),
      );
      try {
        await navigator.clipboard.writeText(result.href);
      } catch {
        const field = document.getElementById("urlShareValue");
        field.value = result.href;
        document.querySelector("#urlShareDialog p").textContent =
          "Clipboard unavailable. Copy the selected link below. It contains your analysis; nothing was uploaded.";
        document.getElementById("urlShareDialog").showModal();
        field.focus();
        field.select();
        return;
      }
      shareStatus.classList.toggle(
        "warning",
        result.tooLong || includeLiteralValues.checked,
      );
      shareStatus.textContent = `${result.summary}. Share link copied.${result.tooLong ? " This URL exceeds about 16 KB; export the bundle instead." : ""}`;
    } catch (error) {
      console.error("Could not create share link:", error);
      shareStatus.classList.add("warning");
      shareStatus.textContent = `Could not create share link: ${error.message}`;
    }
  });

  document
    .getElementById("storedShareLocalLink")
    .addEventListener("click", async () => {
      if (!storedComparison) {
        storedDialog.close();
        shareButton.click();
        return;
      }
      const source = storedComparison;
      if (!source.isCurrent()) {
        updateStoredCreate();
        return;
      }
      try {
        const url = new URL("/", window.location.href);
        url.hash = await encodeShareJson(source.json);
        if (storedComparison !== source || !source.isCurrent()) {
          updateStoredCreate();
          return;
        }
        const warning =
          url.href.length > 16 * 1024
            ? " This link exceeds about 16 KB and may not work in every app. Use encrypted storage or an offline copy if needed."
            : "";
        try {
          await navigator.clipboard.writeText(url.href);
          storedMessage(
            `Reviewed comparison link copied. Nothing uploaded.${warning}`,
            Boolean(warning),
          );
        } catch {
          const field = document.getElementById("urlShareValue");
          field.value = url.href;
          document.querySelector("#urlShareDialog p").textContent =
            `Copy the selected link. It contains the exact reviewed comparison; nothing was uploaded.${warning}`;
          storedDialog.close();
          document.getElementById("urlShareDialog").showModal();
          field.focus();
          field.select();
        }
      } catch (error) {
        storedMessage(error.message, true);
      }
    });

  async function openBundle(bundle, label, generation) {
    if (!workspace.isCurrentImport(generation)) return false;
    if (bundle && Object.hasOwn(bundle, "chquery_comparison")) {
      assertComparisonEvidence(bundle, { pair: true });
      const { openComparisonArtifact } = await import("./comparison-ui.js");
      if (
        !(await openComparisonArtifact(bundle, () =>
          workspace.isCurrentImport(generation),
        ))
      )
        return false;
      if (document.body.dataset.page === "loading")
        document.body.dataset.page = "comparison";
      document.body.dataset.homeLoading = "false";
      return true;
    }
    const result = validateBundle(bundle);
    if (!result.valid || Object.hasOwn(bundle, "chquery_investigation")) {
      const error = new TypeError("Invalid CH Query bundle.");
      error.errors = result.errors;
      throw error;
    }
    const rendered = await workspace.importState(
      wizardFromBundle(bundle),
      generation,
    );
    if (!workspace.isCurrentImport(generation)) return false;
    if (!rendered) {
      shareStatus.classList.add("warning");
      shareStatus.textContent =
        "Could not render this bundle. Previous evidence has been retained.";
      return false;
    }
    renderBundleMetadata(bundle);
    shareStatus.textContent = bundle.redaction?.summary
      ? `${label} ${bundle.redaction.summary}.`
      : `${label} Literal values may be present.`;
    shareStatus.classList.toggle("warning", !bundle.redaction);
    return true;
  }

  let workspaceNavigation = 0;
  for (const type of ["pointerdown", "keydown"])
    document.addEventListener(
      type,
      () => {
        workspaceNavigation++;
      },
      { capture: true },
    );
  function scrollToWorkspace(revealGraph = false) {
    if (document.body.dataset.comparison === "true") return;
    const navigation = workspaceNavigation;
    if (
      !revealGraph &&
      document.body.dataset.page === "results" &&
      !document.querySelector("dialog[open]")
    ) {
      document
        .getElementById("analysisSummaryTitle")
        .focus({ preventScroll: true });
    }
    const scroll = () => {
      if (
        document.body.dataset.comparison === "true" ||
        document.querySelector("dialog[open]") ||
        navigation !== workspaceNavigation
      )
        return;
      const personal = document.body.dataset.page === "results";
      const plan = document.querySelector(
        revealGraph
          ? ".visualizer-area"
          : personal
            ? "#analysisSummary"
            : "#plan",
      );
      const headerHeight =
        document.querySelector(".site-header")?.getBoundingClientRect()
          .height || 56;
      window.scrollTo({
        top: plan.getBoundingClientRect().top + window.scrollY - headerHeight,
      });
    };
    const scrollAfterRender = () => setTimeout(scroll, 150);
    if (document.readyState === "complete") scrollAfterRender();
    else window.addEventListener("load", scrollAfterRender, { once: true });
  }
  window.scrollToWorkspace = scrollToWorkspace;

  function bundleErrorMessage(error) {
    return (
      error.errors?.map((item) => `${item.path}: ${item.message}`).join("; ") ||
      error.message
    );
  }

  window.chqueryOpenShareHash = async (shareHash) => {
    if (!/^#[bjs]=/.test(shareHash)) throw new TypeError('Not a CH Query share link.');
    if (workspace.hasPersonalWork() && !confirm('Open this link and replace your personal analysis and draft?')) return false;
    async function openSharedBundle() {
      const generation = workspace.beginImport();
      showBundleState("loading", "Opening the shared bundle…");
      try {
        const bundle = shareHash.startsWith("#s=")
          ? await loadStoredShare(shareHash)
          : await decodeBundle(shareHash);
        if (await openBundle(bundle, "Shared bundle loaded.", generation))
          scrollToWorkspace();
      } catch (error) {
        if (!workspace.isCurrentImport(generation)) return;
        const retryable = error.status === 429 || error.status >= 500;
        const message = retryable
          ? "This share is temporarily unavailable. Retry in a moment."
          : error.status === 404
            ? "Share not found, deleted or expired. Ask the sender for a new link."
            : `Could not open share link. ${bundleErrorMessage(error)} Ask the sender to check the link.`;
        showBundleState(
          "error",
          message,
          retryable ? openSharedBundle : undefined,
        );
      }
    }
    await openSharedBundle();
  };
  const shareHash = window.location.hash;
  if (/^#[bjs]=/.test(shareHash)) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.hash = "";
    cleanUrl.searchParams.delete("bundle");
    history.replaceState(history.state, "", `${cleanUrl.pathname}${cleanUrl.search}`);
    await window.chqueryOpenShareHash(shareHash);
  } else {
    const bundleUrl = new URLSearchParams(window.location.search).get("bundle");
    if (bundleUrl) {
      const generation = workspace.beginImport();
      showBundleState("loading", "Fetching evidence from the supplied URL.");
      try {
        const source = new URL(bundleUrl, window.location.href);
        if (
          source.protocol !== "https:" &&
          source.origin !== window.location.origin
        ) {
          throw new TypeError("Bundle URL must use HTTPS.");
        }
        const response = await fetch(source);
        if (!response.ok)
          throw new Error(`request returned ${response.status}`);
        const bundle = await response.json();
        if (await openBundle(bundle, "Bundle loaded from URL.", generation))
          scrollToWorkspace();
      } catch (error) {
        if (workspace.isCurrentImport(generation)) {
          shareStatus.classList.add("warning");
          shareStatus.textContent = `Could not load bundle URL: ${bundleErrorMessage(error)}`;
          showBundleState("error", shareStatus.textContent);
        }
      }
    } else if (
      ["baseline", "candidate"].includes(
        new URLSearchParams(window.location.search).get("comparison-side"),
      )
    ) {
      showBundleState(
        "loading",
        "Waiting for a local comparison snapshot. This temporary tab URL does not contain evidence; return to Compare to open it again.",
      );
    } else if (
      new URLSearchParams(window.location.search).get("handoff-workspace") ===
      "1"
    ) {
      // The receiving iframe starts empty, rather than analyzing the large
      // homepage demo concurrently with validation of transferred evidence.
      // This is only a loading view; the normal app hook still validates input.
      showBundleState(
        "loading",
        "Waiting for validated evidence from the temporary handoff. This URL contains no evidence or transfer authority.",
      );
    } else await workspace.showHome(false);
  }
}
