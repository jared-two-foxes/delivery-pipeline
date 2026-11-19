import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiTools } from "../../src/lib/host/pi.mjs";
import { createExecutionRecoveryTools } from "../../src/tools/execution-recovery/tools.mjs";

export default function (pi: ExtensionAPI) {
  registerPiTools(pi, createExecutionRecoveryTools(Type));
}
