import { $, api, esc, toast } from "./lib.js";
import { state } from "./state.js";

/** Only display connection controls for the configured GPT billing mode. Tokens stay on the server. */
export function bindAgentConnection() {
  const panel = $("#agentConnection");
  const agent = state.config.agent;
  if (agent?.provider !== "gpt") return;
  panel.hidden = false;
  if (agent.authMode !== "chatgpt") {
    panel.textContent = `GPT · ${agent.model} · API key（按 API 用量单独计费）`;
    return;
  }
  let current;
  let polling = false;
  let selectedId = "";
  let loginWindow;
  let timer;

  const render = () => {
    const accounts = current.accounts;
    const active = accounts.find((a) => a.id === current.activeAccountId);
    selectedId = accounts.some((a) => a.id === selectedId) ? selectedId : current.activeAccountId ?? "";
    const pending = current.attempt?.status === "pending";
    panel.innerHTML = `<p>GPT · ${esc(agent.model)} · ChatGPT 订阅额度</p>
      <p>${active ? `当前账号：${esc(active.label)} · ${current.planEnabled ? "已授权订阅用量" : "需要登录并授权订阅用量"}` : "请登录 ChatGPT 并授权使用订阅额度。"}</p>
      <select data-chatgpt-account aria-label="ChatGPT 账号">${accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === selectedId ? "selected" : ""}>${esc(a.label)}</option>`).join("")}</select>
      <button type="button" class="btn ghost" data-chatgpt-select ${!accounts.length || pending ? "disabled" : ""}>使用此账号</button>
      <button type="button" class="btn ghost" data-chatgpt-login ${pending ? "disabled" : ""}>Continue with ChatGPT</button>
      <button type="button" class="btn link" data-chatgpt-add ${pending ? "disabled" : ""}>添加账号</button>
      ${pending ? '<button type="button" class="btn link" data-chatgpt-cancel>取消登录</button>' : ""}
      <button type="button" class="btn link" data-chatgpt-logout ${!accounts.length || pending ? "disabled" : ""}>退出所选账号</button>
      <button type="button" class="btn link" data-chatgpt-models>查看可用模型</button>
      <p>${pending ? "等待浏览器授权…" : current.attempt?.status === "error" ? esc(current.attempt.error) : "额度与访问权限可在 ChatGPT 设置中管理；额度不足时本应用不会自动切换到付费 API。"}
      <a href="https://chatgpt.com/#settings" target="_blank" rel="noopener noreferrer">ChatGPT 设置</a></p>
      <small>图像生成通道独立配置、独立计费。</small>`;
  };
  const refresh = async () => {
    current = await api("/api/chatgpt/status");
    render();
    if (current.attempt?.status !== "pending") {
      polling = false;
      clearTimeout(timer);
      return;
    }
    if (polling) timer = setTimeout(() => refresh().catch((err) => { polling = false; toast(err.message); }), 1500);
  };
  panel.addEventListener("change", (event) => {
    if (event.target.matches("[data-chatgpt-account]")) selectedId = event.target.value;
  });
  panel.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    try {
      if (button.matches("[data-chatgpt-login], [data-chatgpt-add]")) {
        loginWindow = window.open("about:blank", "_blank");
        if (!loginWindow) throw new Error("浏览器阻止了登录窗口，请允许弹出窗口后重试");
        loginWindow.opener = null;
        const accountId = button.matches("[data-chatgpt-add]") ? undefined : selectedId || undefined;
        const result = await api("/api/chatgpt/login", { method: "POST", body: { accountId } });
        loginWindow.location.href = result.url;
        polling = true;
        await refresh();
      } else if (button.matches("[data-chatgpt-select]")) {
        await api("/api/chatgpt/account", { method: "POST", body: { accountId: selectedId } });
        await refresh();
      } else if (button.matches("[data-chatgpt-cancel]")) {
        await api("/api/chatgpt/cancel", { method: "POST", body: {} });
        polling = false;
        clearTimeout(timer);
        loginWindow?.close();
        await refresh();
      } else if (button.matches("[data-chatgpt-logout]")) {
        const result = await api("/api/chatgpt/logout", { method: "POST", body: { accountId: selectedId } });
        toast(result.message);
        await refresh();
      } else if (button.matches("[data-chatgpt-models]")) {
        const result = await api("/api/chatgpt/models");
        toast(`可用模型：${result.models.map((m) => m.id).join("、")}；在 .env 的 GPT_MODEL 中配置。`);
      }
    } catch (err) {
      if (button.matches("[data-chatgpt-login], [data-chatgpt-add]")) loginWindow?.close();
      toast(err.message);
    }
  });
  refresh().catch((err) => { panel.textContent = `ChatGPT 连接不可用：${err.message}`; });
}
