import { acknowledgeHandoff, declineHandoff, getHandoffStatus, grantHandoff, parseHandoffInvitation, retrieveHandoff } from "./handoff-transport.js";
import { getStoredShareConfig } from "./stored-share.js";

const $ = id => document.getElementById(id);
let invitation, status, grant, busy = false, terminal = false, pollTimer, turnstileToken = "", widgetId;

function message(text, error = false) {
  $("handoffStatus").textContent = text;
  $("handoffStatus").classList.toggle("warning", error);
}

function update() {
  const expired = !status || status.expiresAt <= Date.now();
  $("handoffAllow").disabled = terminal || busy || expired || status?.state === "denied" || status?.state === "consumed" || !status?.agentOnline;
  $("handoffDecline").disabled = terminal || busy || expired || status?.state !== "pending";
  $("handoffAgent").textContent = terminal ? "Unavailable" : status?.agentOnline ? "Online and waiting" : "Offline";
  if (status?.expiresAt) $("handoffExpiry").textContent = terminal ? "Unavailable" : expired ? "Expired" : `Expires ${new Date(status.expiresAt).toLocaleTimeString()}`;
}

async function readStatus() {
  if (terminal) return;
  try {
    const latest = await getHandoffStatus(invitation.id);
    if (terminal) return;
    status = latest;
    update();
    if (!busy && status.state === "pending") message(status.agentOnline ? "Ready for your decision. No evidence has been uploaded." : "The agent is offline. Ask it to restart this handoff.", !status.agentOnline);
    if (status.state === "denied") message("Temporary transfer was declined. No evidence was uploaded.");
  } catch (error) {
    if (terminal) return;
    message(error.message, true);
    $("handoffAllow").disabled = $("handoffDecline").disabled = true;
    if ([403, 404, 410].includes(error.status)) {
      terminal = true;
      clearInterval(pollTimer);
      $("handoffExpiry").textContent = error.status === 403 ? "Authorization ended" : "Expired";
      $("handoffAgent").textContent = "Unavailable";
    }
  }
}

async function loadTurnstile() {
  const config = await getStoredShareConfig();
  if (!config.enabled || !config.turnstileSiteKey) return "";
  if (!window.turnstile) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; script.async = true;
      script.onload = resolve; script.onerror = () => reject(new Error("Verification could not load. No transfer was authorized."));
      document.head.append(script);
    });
  }
  return new Promise((resolve, reject) => {
    if (widgetId !== undefined) window.turnstile.remove(widgetId);
    widgetId = window.turnstile.render("#handoffChallenge", { sitekey: config.turnstileSiteKey, action: "handoff-transfer", size: "flexible",
      callback: resolve, "expired-callback": () => reject(new Error("Verification expired. Choose Allow again.")),
      "error-callback": () => reject(new Error("Verification failed. No transfer was authorized.")) });
  });
}

async function openWorkspace(received) {
  const frame = document.createElement("iframe");
  const cleanupStatus = $("handoffCleanupStatus");
  const transferActions = $("handoffTransferActions");
  const save = $("handoffSave");
  frame.title = "CH Query analysis workspace"; frame.src = "/?handoff-workspace=1";
  $("handoffWorkspace").replaceChildren(transferActions, frame);
  await new Promise((resolve, reject) => { frame.onload = resolve; frame.onerror = reject; });
  const accepted = await frame.contentWindow.chqueryOpenTransferredArtifact?.({ json: received.json });
  if (!accepted) throw new Error("The analysis workspace did not accept the validated evidence. Retry while this grant remains valid.");
  $("handoffPanel").hidden = true; $("handoffWorkspace").hidden = false; document.body.classList.add("workspace-open");
  const canSaveExactComparison = received.artifact?.chquery_comparison === 1 && typeof frame.contentWindow.openStoredComparisonShare === "function";
  save.hidden = !canSaveExactComparison;
  transferActions.hidden = !canSaveExactComparison;
  save.onclick = canSaveExactComparison ? () => frame.contentWindow.openStoredComparisonShare({ json: received.json, isCurrent: () => frame.isConnected }) : null;
  clearInterval(pollTimer);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await acknowledgeHandoff(invitation, grant.transferToken);
      cleanupStatus.hidden = true;
      return;
    } catch {
      transferActions.hidden = false;
      cleanupStatus.hidden = false;
      cleanupStatus.textContent = attempt < 2
        ? "Analysis opened in memory. Confirming temporary relay cleanup again…"
        : "Analysis opened in memory, but relay cleanup could not be confirmed. The temporary ciphertext remains subject to the invitation expiry; no seven-day share was created.";
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

async function receive() {
  for (;;) {
    status = await getHandoffStatus(invitation.id);
    update();
    if (status.state === "ready") break;
    if (status.state === "pending") throw new Error("The upload was not published. Choose Allow again to issue a new scoped grant.");
    if (["denied", "consumed"].includes(status.state) || status.expiresAt <= Date.now()) throw new Error("The transfer ended before evidence became available.");
    message(status.agentOnline ? "Authorization granted. Waiting for the agent to upload encrypted evidence…" : "Authorization granted, but the agent disconnected. Keep this page open and restart it.", !status.agentOnline);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  message("Downloading encrypted evidence…");
  $("handoffProgress").hidden = false; $("handoffProgress").removeAttribute("value");
  const received = await retrieveHandoff(invitation, grant.transferToken, status);
  message("Integrity and schema checks passed. Opening the real CH Query workspace without saving…");
  await openWorkspace(received);
}

$("handoffAllow").onclick = async () => {
  if ($("handoffAllow").disabled) return;
  busy = true; update(); message("Complete verification to authorize these exact encrypted bytes…");
  try {
    turnstileToken = await loadTurnstile();
    grant = await grantHandoff(invitation, turnstileToken);
    await receive();
  } catch (error) {
    const recovery = [404, 410].includes(error.status) ? "Ask the agent for a new invitation."
      : error.status === 403 ? "Authorization ended; ask the agent for a new invitation."
      : "Choose Allow again for a scoped renewal.";
    if ([403, 404, 410].includes(error.status)) { terminal = true; clearInterval(pollTimer); }
    message(`${error.message} ${recovery} No seven-day share was created.`, true);
    busy = false; $("handoffProgress").hidden = true; update();
  }
};

$("handoffDecline").onclick = async () => {
  busy = true; update();
  try { await declineHandoff(invitation); status = { ...status, state: "denied" }; message("Temporary transfer declined. No evidence was uploaded or saved."); }
  catch (error) { busy = false; message(error.message, true); update(); }
};

try {
  invitation = parseHandoffInvitation(location.hash);
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  $("handoffKind").textContent = invitation.manifest.kind === "comparison" ? "Baseline and candidate comparison"
    : invitation.manifest.kind === "investigation" ? "Query investigation" : "Single-query analysis";
  $("handoffSize").textContent = `${invitation.manifest.plaintextBytes.toLocaleString()} bytes before compression`;
  $("handoffDisclosure").textContent = JSON.stringify(invitation.manifest.disclosure, null, 2);
  await readStatus();
  if (!terminal) pollTimer = setInterval(readStatus, 2000);
} catch (error) {
  terminal = true;
  $("handoffKind").textContent = "Unavailable";
  $("handoffExpiry").textContent = "Invalid";
  $("handoffAgent").textContent = "Unavailable";
  $("handoffDisclosure").textContent = "No valid attested disclosure is available.";
  message(error.message, true); $("handoffAllow").disabled = $("handoffDecline").disabled = true;
}
