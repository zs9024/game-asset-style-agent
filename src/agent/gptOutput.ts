import type { ResponseOutputItem, ResponseStreamEvent } from "openai/resources/responses/responses";
import { msg } from "../i18n.js";

/** Subscription streams can carry their actual outputs in item.done and an empty terminal snapshot. */
export class GptOutput {
  private completed = new Map<number, ResponseOutputItem>();

  observe(event: ResponseStreamEvent) {
    if (event.type !== "response.output_item.done") return;
    if (!Number.isSafeInteger(event.output_index) || event.output_index < 0) throw new Error(msg("err.gptOutputInvalid"));
    const previous = this.completed.get(event.output_index);
    if (previous && (previous.type !== event.item.type || previous.id !== event.item.id)) throw new Error(msg("err.gptOutputInvalid"));
    this.completed.set(event.output_index, event.item);
  }

  finish(terminal: ResponseOutputItem[]): ResponseOutputItem[] {
    const streamed = [...this.completed].sort(([a], [b]) => a - b).map(([, item]) => item);
    const result = [...streamed];
    for (const final of terminal) {
      const at = result.findIndex((candidate) => (!!final.id && candidate.id === final.id) || (candidate.type === "function_call" && final.type === "function_call" && candidate.call_id === final.call_id));
      if (at < 0) result.push(final);
      else {
        const item = result[at];
        if (final.type !== item.type || (final.type === "function_call" && item.type === "function_call"
          && (final.call_id !== item.call_id || final.name !== item.name || (final.namespace && item.namespace && final.namespace !== item.namespace) || final.arguments !== item.arguments))) {
          throw new Error(msg("err.gptOutputInvalid"));
        }
        // Preserve phase/encrypted reasoning when a terminal item omits optional replay fields.
        result[at] = { ...item, ...final } as ResponseOutputItem;
      }
    }
    if (!result.length) throw new Error(msg("err.gptNoOutput"));
    const calls = new Set<string>();
    for (const item of result) {
      if (item.type === "message" && item.status !== "completed") throw new Error(msg("err.gptOutputInvalid"));
      if (item.type === "function_call") {
        if (!item.call_id || !item.name || typeof item.arguments !== "string" || (item.status && item.status !== "completed") || calls.has(item.call_id)) throw new Error(msg("err.gptOutputInvalid"));
        calls.add(item.call_id);
      }
    }
    return result;
  }
}
