import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiTools } from "../../src/lib/host/pi.mjs";
import { createReviewTool } from "../../src/tools/review/tool.mjs";

export default function (pi: ExtensionAPI) {
  registerPiTools(pi, [createReviewTool(Type)]);
}
