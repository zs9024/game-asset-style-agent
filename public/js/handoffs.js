import { $, api, esc, toast } from "./lib.js";
import { state } from "./state.js";

const STATUS = { waiting: "等待人工生图", submitted: "图片已收到", cancelled: "已取消，可上传后接续", expired: "已超时，可上传后接续", imported: "已入库" };

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
      panel.innerHTML = `<h3>ChatGPT 人工接力</h3><p class="muted">下载提示词和参考图，在 ChatGPT 生图后上传原图。原任务会继续审核；运行中断时可点「继续审核」。</p>${visible.map((task) => {
        const base = `/api/projects/${projectId}/handoffs/${task.id}`;
        const canUpload = ["waiting", "cancelled", "expired"].includes(task.status);
        return `<article class="handoff-card" data-handoff="${esc(task.id)}">
          <b>${esc(task.name)}</b> <span class="muted">${STATUS[task.status] ?? esc(task.status)} · ${task.referenceCount} 张参考图${task.status === "waiting" && !task.live ? " · 原运行已中断" : ""}</span>
          <div class="handoff-actions"><a class="btn ghost" href="${base}/package.zip" download>下载提示词与参考图 ZIP</a>
          <button type="button" class="btn link" data-copy-handoff>复制提示词</button>
          ${canUpload ? '<label class="btn ghost">上传生成结果<input type="file" data-upload-handoff accept="image/png,image/jpeg,image/webp" hidden /></label>' : ""}
          ${task.status === "submitted" && !task.live ? '<button type="button" class="btn primary" data-resume-handoff>继续审核</button>' : ""}
          ${task.status === "waiting" ? '<button type="button" class="btn link danger" data-cancel-handoff>取消并停止本次运行</button>' : ""}</div>
          <details><summary>查看提示词</summary><pre>${esc(task.prompt)}</pre></details></article>`;
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
        await navigator.clipboard.writeText(task.prompt); toast("提示词已复制");
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
      toast(result.needsResume ? "图片已收到，点击「继续审核」接续任务" : "图片已收到，Agent 将继续审核");
    } catch (error) { input.disabled = false; toast(error.message); }
    finally { fileBusy = false; await refresh(); }
  });
  panel.addEventListener("cancel", () => { fileBusy = false; }, true);
  document.addEventListener("gaa:handoff-change", () => void refresh());
  document.addEventListener("gaa:project-switch", (event) => { panel.hidden = true; signature = ""; fileBusy = false; projectTarget = event.detail.to; queueMicrotask(() => void refresh()); });
  setInterval(() => { if (!document.hidden && state.project) void refresh(); }, 3000);
}
