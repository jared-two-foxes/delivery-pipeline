import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiTools } from "../../src/lib/host/pi.mjs";
import { createScaffoldTools } from "../../src/tools/scaffold/tools.mjs";

export default function (pi: ExtensionAPI) {
  registerPiTools(pi, createScaffoldTools(Type));
}
