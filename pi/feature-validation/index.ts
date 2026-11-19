import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiTools } from "../../src/lib/host/pi.mjs";
import { createFeatureValidationTools } from "../../src/tools/feature-validation/tools.mjs";

export default function (pi: ExtensionAPI) {
  registerPiTools(pi, createFeatureValidationTools(Type));
}
