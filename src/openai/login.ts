import "dotenv/config";
import { chatGPTAuth } from "./chatgpt.js";

// Run locally before copying the protected auth directory to a self-hosted instance.
try {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === "--new") && !(args.length === 2 && args[0] === "--account")) {
    throw new Error("用法：npm run chatgpt:login -- [--new | --account oaiapp_…]");
  }
  const status = await chatGPTAuth.status();
  const accountId = args[0] === "--new" ? undefined : args[0] === "--account" ? args[1] : status.activeAccountId;
  const login = await chatGPTAuth.startLogin(accountId, false);
  console.log("请在本机浏览器打开以下地址，登录并授权 ChatGPT 订阅用量：");
  console.log(login.url); // No retained ID-token hint is included in the CLI URL.
  process.once("SIGINT", () => { chatGPTAuth.close(); process.exit(130); });
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const current = await chatGPTAuth.status();
    if (current.attempt?.status === "pending") continue;
    if (current.attempt?.status !== "complete") throw new Error(current.attempt?.error ?? "登录未完成");
    if (!current.planEnabled) throw new Error("已登录，但未授权 ChatGPT 订阅用量，请重新运行并完成授权");
    console.log("ChatGPT 登录完成，凭证已保存到 DATA_DIR/auth/chatgpt.json。");
    break;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : "ChatGPT 登录失败");
  process.exitCode = 1;
} finally {
  chatGPTAuth.close();
}
