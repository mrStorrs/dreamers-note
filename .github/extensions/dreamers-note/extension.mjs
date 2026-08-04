import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { joinSession } from "@github/copilot-sdk/extension";

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function loadBridge() {
  return require(path.join(repositoryRoot, "dist", "copilot-cli-extension.js"));
}

function unavailableTool(error) {
  return {
    name: "dreamers_note_setup_status",
    description: "Explain how to build the local dreamers-note Copilot CLI tools when they are unavailable.",
    parameters: { type: "object", additionalProperties: false },
    handler: async () => JSON.stringify({
      isError: true,
      error: "dreamers-note is not built. Run `npm run build` from this repository, then restart Copilot CLI or use /clear.",
      detail: String(error?.message ?? error),
    }),
  };
}

let tools;
try {
  const bridge = loadBridge();
  tools = bridge.listCopilotCliToolDefinitions().map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    handler: async (argumentsValue) => {
      const result = bridge.callCopilotCliTool(repositoryRoot, definition.name, argumentsValue ?? {});
      return bridge.formatCopilotCliToolResult(result);
    },
  }));
} catch (error) {
  tools = [unavailableTool(error)];
}

await joinSession({ tools });
