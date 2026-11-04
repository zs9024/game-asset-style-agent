import { $, api, esc, toast } from "./lib.js";
import { has, t } from "./i18n.js";
import { state } from "./state.js";

const statusLabel = (status) => (has(`handoff.status.${status}`) ? t(`handoff.status.${status}`) : esc(status));

/** Human work can outlive the SSE connection or original job. Re-fetch durable task state. */
export function bindHandoffs(onResume) {
  const panel = $("#handoffPanel");
  let tasks = [];
  let loading = false;
  let fileBusy = false;
  let signature = "";
  let projectTarget;
  const refresh = async () => {
    const projectId = state.project?.id;
    if (!projectId || (projectTarget && projectTarget !== projectId) || loading || fileBusy) return;
    loading = true;
    try {
      const result = await api(`/api/projects/${projectId}/handoffs`);
      if (state.project?.id !== projectId) return;
      tasks = result.tasks;
      const nextSignature = JSON.stringify({ projectId, tasks });
      if (nextSignature === signature || fileBusy) return;
      signature = nextSignature;
      const visible = tasks.filter((task) => task.status !== "imported");
      panel.hidden = !visible.length;
      panel.innerHTML = `<h3>${t("handoff.heading")}</h3><p class="muted">${t("handoff.intro")}</p>${visible.map((task) => {
        const base = `/api/projects/${projectId}/handoffs/${task.id}`;
        const canUpload = ["waiting", "cancelled", "expired"].includes(task.status);
        return `<article class="handoff-card" data-handoff="${esc(task.id)}">
          <b>${esc(task.name)}</b> <span class="muted">${statusLabel(task.status)} · ${t("handoff.refs", { n: task.referenceCount })}${task.status === "waiting" && !task.live ? t("handoff.interrupted") : ""}</span>
          <div class="handoff-actions"><a class="btn ghost" href="${base}/package.zip" download>${t("handoff.downloadZip")}</a>
          <button type="button" class="btn link" data-copy-handoff>${t("handoff.copyPrompt")}</button>
          ${canUpload ? `<label class="btn ghost">${t("handoff.upload")}<input type="file" data-upload-handoff accept="image/png,image/jpeg,image/webp" hidden /></label>` : ""}
          ${task.status === "submitted" && !task.live ? `<button type="button" class="btn primary" data-resume-handoff>${t("handoff.resume")}</button>` : ""}
          ${task.status === "waiting" ? `<button type="button" class="btn link danger" data-cancel-handoff>${t("handoff.cancel")}</button>` : ""}</div>
          <details><summary>${t("handoff.showPrompt")}</summary><pre>${esc(task.prompt)}</pre></details></article>`;
      }).join("")}`;
    } catch (error) { if (state.project?.id === projectId) toast(error.message); }
    finally { loading = false; }
  };
  panel.addEventListener("click", async (event) => {
    if (event.target.matches("[data-upload-handoff]")) fileBusy = true;
    const card = event.target.closest("[data-handoff]");
    if (!card) return;
    const task = tasks.find((item) => item.id === card.dataset.handoff);
    const projectId = state.project?.id;
    if (!task || !projectId) return;
    try {
      if (event.target.closest("[data-copy-handoff]")) {
        await navigator.clipboard.writeText(task.prompt); toast(t("handoff.copied"));
      } else if (event.target.closest("[data-cancel-handoff]")) {
        await api(`/api/projects/${projectId}/handoffs/${task.id}/cancel`, { method: "POST", body: {} }); await refresh();
      } else if (event.target.closest("[data-resume-handoff]")) {
        const result = await api(`/api/projects/${projectId}/handoffs/${task.id}/resume`, { method: "POST", body: {} });
        if (state.project?.id === projectId) onResume(result.jobId);
        await refresh();
      }
    } catch (error) { toast(error.message); }
  });
  panel.addEventListener("change", async (event) => {
    const input = event.target.closest("[data-upload-handoff]");
    const card = input?.closest("[data-handoff]");
    if (!input?.files?.[0] || !card || !state.project) return;
    const projectId = state.project.id;
    fileBusy = true;
    const body = new FormData(); body.append("image", input.files[0]); input.disabled = true;
    try {
      const result = await api(`/api/projects/${projectId}/handoffs/${card.dataset.handoff}/result`, { method: "POST", body });
      toast(result.needsResume ? t("handoff.receivedResume") : t("handoff.receivedContinue"));
    } catch (error) { input.disabled = false; toast(error.message); }
    finally { fileBusy = false; await refresh(); }
  });
  panel.addEventListener("cancel", () => { fileBusy = false; }, true);
  document.addEventListener("gaa:handoff-change", () => void refresh());
  document.addEventListener("gaa:lang", () => void refresh());
  document.addEventListener("gaa:project-switch", (event) => { panel.hidden = true; signature = ""; fileBusy = false; projectTarget = event.detail.to; queueMicrotask(() => void refresh()); });
  setInterval(() => { if (!document.hidden && state.project) void refresh(); }, 3000);
}
