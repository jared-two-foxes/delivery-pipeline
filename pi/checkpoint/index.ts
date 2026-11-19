import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiTools } from "../../src/lib/host/pi.mjs";
import { createCheckpointTools } from "../../src/tools/checkpoint/tools.mjs";

export default function (pi: ExtensionAPI) {
  registerPiTools(pi, createCheckpointTools(Type));
}
