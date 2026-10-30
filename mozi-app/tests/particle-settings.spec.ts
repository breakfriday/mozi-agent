import { expect, test } from "@playwright/test";

test("particle settings work without a native renderer and save through the bridge", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { electronAPI: {
      particleSettings: {
        get: async () => ({ style: "auto", wallpaper: null, paused: false, cruise: true, depth: 1 }),
        chooseWallpaper: async () => "/tmp/example.png",
        save: async (settings: unknown) => { Object.assign(window, { savedParticleSettings: settings }); },
      },
      window: { getState: async () => ({ isFullScreen: false }), onStateChanged: () => () => {} },
    } });
  });
  await page.goto("/mozi_app/particleSettings");
  await expect(page.getByRole("button", { name: "保存并应用" })).toBeVisible();
  await page.getByRole("button", { name: "选择图片" }).click();
  await expect(page.getByText("/tmp/example.png")).toBeVisible();
  await page.getByRole("switch", { name: "暂停动画" }).click();
  await page.getByRole("switch", { name: "镜头巡航" }).click();
  await page.getByRole("button", { name: "保存并应用" }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { savedParticleSettings: unknown }).savedParticleSettings)).toEqual({ style: "auto", wallpaper: "/tmp/example.png", paused: true, cruise: false, depth: 1 });
  await page.screenshot({ path: "/tmp/mozi-particle-settings.png" });
});
