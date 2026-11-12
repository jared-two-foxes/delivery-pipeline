// Which of a package's declared dependencies cannot be resolved. No imports beyond node: built-ins, so it
// can run before anything else is installed (the MCP launcher and Pi's transport check both use it).
// Resolution walks up from the package like Node does: in a workspace install, npm hoists dependencies
// into the repository root's node_modules instead of the package's own.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function missingDependencies(packageDir) {
  const { dependencies = {} } = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const resolvable = (name) => {
    for (let dir = path.resolve(packageDir), previous; dir !== previous; previous = dir, dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, "node_modules", ...name.split("/"), "package.json"))) return true;
    }
    return false;
  };
  return Object.keys(dependencies).filter((name) => !resolvable(name));
}
