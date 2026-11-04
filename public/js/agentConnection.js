import { $, api, esc, toast } from "./lib.js";
import { t } from "./i18n.js";
import { state } from "./state.js";

/** Only display connection controls for the configured GPT billing mode. Tokens stay on the server. */
export function bindAgentConnection() {
  const panel = $("#agentConnection");
  const agent = state.config.agent;
  if (agent?.provider !== "gpt") return;
  panel.hidden = false;
  if (agent.authMode !== "chatgpt") {
    panel.textContent = t("agentConnection.apiKeyNote", { model: agent.model });
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
    panel.innerHTML = `<p>${esc(t("agentConnection.subscriptionLine", { model: agent.model }))}</p>
      <p>${active ? esc(t("agentConnection.currentAccount", { label: active.label, plan: t(current.planEnabled ? "agentConnection.planEnabled" : "agentConnection.planNeedsAuth") })) : t("agentConnection.pleaseLogin")}</p>
      <select data-chatgpt-account aria-label="${t("agentConnection.accountAria")}">${accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === selectedId ? "selected" : ""}>${esc(a.label)}</option>`).join("")}</select>
      <button type="button" class="btn ghost" data-chatgpt-select ${!accounts.length || pending ? "disabled" : ""}>${t("agentConnection.useAccount")}</button>
      <button type="button" class="btn ghost" data-chatgpt-login ${pending ? "disabled" : ""}>Continue with ChatGPT</button>
      <button type="button" class="btn link" data-chatgpt-add ${pending ? "disabled" : ""}>${t("agentConnection.addAccount")}</button>
      ${pending ? `<button type="button" class="btn link" data-chatgpt-cancel>${t("agentConnection.cancelLogin")}</button>` : ""}
      <button type="button" class="btn link" data-chatgpt-logout ${!accounts.length || pending ? "disabled" : ""}>${t("agentConnection.logoutAccount")}</button>
      <button type="button" class="btn link" data-chatgpt-models>${t("agentConnection.viewModels")}</button>
      <p>${pending ? t("agentConnection.waiting") : current.attempt?.status === "error" ? esc(current.attempt.error) : t("agentConnection.quotaNote")}
      <a href="https://chatgpt.com/#settings" target="_blank" rel="noopener noreferrer">${t("agentConnection.settings")}</a></p>
      <small>${t("agentConnection.imageNote")}</small>`;
  };
  document.addEventListener("gaa:lang", render);
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
        if (!loginWindow) throw new Error(t("agentConnection.blockedPopup"));
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
        toast(t("agentConnection.models", { models: result.models.map((m) => m.id).join(", ") }));
      }
    } catch (err) {
      if (button.matches("[data-chatgpt-login], [data-chatgpt-add]")) loginWindow?.close();
      toast(err.message);
    }
  });
  refresh().catch((err) => { panel.textContent = t("agentConnection.unavailable", { message: err.message }); });
}
