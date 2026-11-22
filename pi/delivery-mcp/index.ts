/**
 * Serves the delivery tools to Pi through the MCP server (mcp/). This is the only transport for them: there is no
 * native fallback. If the server cannot start, Pi is told why.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MCP_SERVER_NAME, deliveryMcpServerConfig, deliveryServer } from "../../src/lib/host/pi.mjs";

export default function (pi: ExtensionAPI) {
  const server = deliveryServer();
  if (server.ok) pi.registerMcpServer(MCP_SERVER_NAME, deliveryMcpServerConfig(server.serverPath));
  if (server.warning) {
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(server.warning!, "error");
    });
  }
}
