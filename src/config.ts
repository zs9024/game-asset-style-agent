import path from "node:path";

/** Settings read from the environment. Read lazily so tests can set env vars before use. */
export const config = {
  get agentProvider(): "claude" | "deepseek" | "gpt" {
    const provider = process.env.AGENT_PROVIDER?.trim() || "claude";
    if (provider !== "claude" && provider !== "deepseek" && provider !== "gpt") throw new Error("AGENT_PROVIDER 必须为 claude、deepseek 或 gpt");
    return provider;
  },
  get model() {
    if (this.agentProvider === "gpt") return process.env.GPT_MODEL?.trim() || "gpt-6.1-sol";
    if (this.agentProvider === "deepseek") return process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash";
    return process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
  },
  get effort() {
    if (this.agentProvider === "gpt") {
      const effort = process.env.GPT_EFFORT?.trim() || "medium";
      if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("GPT_EFFORT 必须为 low、medium、high、xhigh 或 max");
      return effort as "low" | "medium" | "high" | "xhigh" | "max";
    }
    if (this.agentProvider === "deepseek") {
      const effort = process.env.DEEPSEEK_EFFORT?.trim() || "high";
      if (effort !== "low" && effort !== "high" && effort !== "max") throw new Error("DEEPSEEK_EFFORT 必须为 low、high 或 max");
      return effort;
    }
    return (process.env.CLAUDE_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max";
  },
  get maxTurns() {
    return Number(process.env.AGENT_MAX_TURNS ?? 40);
  },
  get gptAuthMode(): "api_key" | "chatgpt" {
    const mode = process.env.GPT_AUTH_MODE?.trim() || "api_key";
    if (mode !== "api_key" && mode !== "chatgpt") throw new Error("GPT_AUTH_MODE 必须为 api_key 或 chatgpt");
    return mode;
  },
  /** Past this size a project starts a fresh conversation so requests stay well under the API's size limit. */
  get conversationLimitBytes() {
    return Number(process.env.CONVERSATION_LIMIT_MB ?? 12) * 1024 * 1024;
  },
  get demo() {
    return process.env.AGENT_MODE === "demo";
  },
  get dataDir() {
    return path.resolve(process.env.DATA_DIR ?? "data");
  },
  /** When set, every page and API call requires logging in with this token. */
  get accessToken() {
    return process.env.ACCESS_TOKEN?.trim() || null;
  },
  get port() {
    return Number(process.env.PORT ?? 5173);
  },
};
