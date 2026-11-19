import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiTools } from "../../src/lib/host/pi.mjs";
import { createExecuteAndReviewTools } from "../../src/tools/execute-and-review/tools.mjs";

export default function (pi: ExtensionAPI) {
  registerPiTools(pi, createExecuteAndReviewTools(Type));
}
