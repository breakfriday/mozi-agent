import { _electron, test as base, expect, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const electronRoot = fileURLToPath(new URL("../../../mozi-electron/", import.meta.url));
const executablePath = createRequire(path.join(electronRoot, "package.json"))("electron") as string;
const playwrightRequire = createRequire(createRequire(import.meta.url).resolve("playwright"));
const electronLoader = path.join(path.dirname(playwrightRequire.resolve("playwright-core/package.json")), "lib/server/electron/loader.js");

type Desktop = { app: ElectronApplication; page: Page; restart: () => Promise<void> };

export const test = base.extend<{ desktop: Desktop }>({
  // Playwright requires destructuring here even when no built-in fixtures are used.
  // eslint-disable-next-line no-empty-pattern
  desktop: async ({}, provide, testInfo) => {
    const userData = await mkdtemp(path.join(tmpdir(), "mozi-e2e-"));
    const logs: string[] = [];
    let app: ElectronApplication | undefined;
    let launchIndex = 0;
    const stop = async () => {
      if (!app) return;
      const current = app;
      app = undefined;
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          for (const [index, page] of current.windows().entries()) {
            await page.screenshot({ path: testInfo.outputPath(`window-${launchIndex}-${index}.png`) }).catch(() => {});
          }
        }
        const tracePath = testInfo.outputPath(`trace-${launchIndex}.zip`);
        try {
          await current.context().tracing.stop({ path: tracePath });
          await testInfo.attach(`trace-${launchIndex}`, { path: tracePath, contentType: "application/zip" });
        } catch (error) {
          // A crashed application may already have closed its tracing context.
          logs.push(`Trace capture failed: ${String(error)}\n`);
        }
      } finally {
        const child = current.process();
        const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
        await current.close();
        await exited;
      }
    };
    const launch = async () => {
      const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.MOZI_AGENT_DEBUG;
      delete env.MOZI_AGENT_PROVIDER;
      delete env.MOZI_AGENT_MODEL;
      app = await _electron.launch({
        executablePath,
        // With executablePath, Playwright skips its normal ready-event loader.
        // Install it explicitly so windows/preload cannot race debugger attachment.
        args: ["-r", electronLoader, `--user-data-dir=${userData}`, fileURLToPath(new URL("./launch.cjs", import.meta.url))],
        cwd: electronRoot,
        env: { ...env, MOZI_E2E_USER_DATA: userData, MOZI_AGENT_CWD: path.join(userData, "workspace"),
          ELECTRON_RENDERER_MODE: "dev", ELECTRON_RENDERER_URL: "http://127.0.0.1:5187/mozi_app/" },
      });
      launchIndex++;
      app.process().stdout?.on("data", chunk => logs.push(String(chunk)));
      app.process().stderr?.on("data", chunk => logs.push(String(chunk)));
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await expect.poll(async () => page.evaluate(async () => {
        const result = await window.mozi?.agent.getRuntimeState();
        return result?.ok ? result.result.state : result ?? "bridge missing";
      })).toBe("ready");
      await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
      await expect(page.getByRole("button", { name: "新建会话", exact: true })).toBeEnabled();
      return { app, page };
    };
    try {
      const desktop: Desktop = {
        ...await launch(),
        restart: async () => { await stop(); Object.assign(desktop, await launch()); },
      };
      await provide(desktop);
    } finally {
      try { await stop(); }
      finally {
        logs.push(await readFile(path.join(userData, "startup.log"), "utf8").catch(() => ""));
        await testInfo.attach("electron.log", { body: logs.join(""), contentType: "text/plain" });
        await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  },
});

export { expect };
