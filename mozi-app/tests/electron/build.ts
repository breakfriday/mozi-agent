import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function buildElectron() {
  execFileSync(process.execPath, [fileURLToPath(new URL("../../../mozi-electron/scripts/build-e2e.cjs", import.meta.url))], {
    stdio: "inherit",
  });
}
