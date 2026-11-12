import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rulesPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "delivery-rules.md");

/**
 * Adds the delivery pipeline's operating rules to Pi's system prompt as an
 * extra section, so they compose with Pi's default prompt and any personal
 * SYSTEM.md / APPEND_SYSTEM.md instead of replacing them.
 */
export default function deliveryPrompt(pi: any) {
  pi.on("before_agent_start", async (event: any) => {
    if (!existsSync(rulesPath)) return;
    const options = event.systemPromptOptions;
    if (!options) return;
    options.sections = options.sections ?? {};
    options.sections["delivery-rules"] = readFileSync(rulesPath, "utf8").trim();
  });
}
