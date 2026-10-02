import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const root = join(toolsDir, "..");
const script = join(toolsDir, "build.ps1");
const result = spawnSync(
  "powershell",
  ["-ExecutionPolicy", "Bypass", "-File", script],
  { cwd: root, stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
