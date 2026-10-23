import { expect, test } from "@playwright/test";

test("four themes update global and modal colors and survive reload", async ({ page }) => {
  await page.goto("/mozi_app/chat", { waitUntil: "domcontentloaded" });
  const themes = [
    { key: "gruvbox-dark", label: "Gruvbox 深色", dark: true, surface: "rgb(40, 40, 40)", elevated: "rgb(50, 48, 47)" },
    { key: "gruvbox-light", label: "Gruvbox 浅色", dark: false, surface: "rgb(251, 241, 199)", elevated: "rgb(251, 241, 199)" },
    { key: "light", label: "默认浅色", dark: false, surface: "rgb(255, 255, 255)", elevated: "rgb(255, 255, 255)" },
    { key: "dark", label: "默认深色", dark: true, surface: "rgb(34, 34, 34)", elevated: "rgb(38, 38, 38)" },
  ];
  for (const theme of themes) {
    await page.getByRole("button", { name: "切换主题", exact: true }).click();
    await page.getByRole("menuitem", { name: theme.label, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.key);
    await expect(page.getByRole("region", { name: "智能对话", exact: true })).toHaveCSS("background-color", theme.surface);
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme.dark);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme.key);
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "切换会话", exact: true });
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await expect(dialog.locator(".ant-modal-container")).toHaveCSS("background-color", theme.elevated);
    await expect(dialog.locator(".ant-input-affix-wrapper")).toHaveCSS("background-color", theme.key === "gruvbox-light" ? "rgb(242, 229, 188)" : theme.key === "gruvbox-dark" ? "rgb(40, 40, 40)" : theme.key === "light" ? "rgb(247, 247, 247)" : "rgb(38, 38, 38)");
    await page.screenshot({ path: `/tmp/mozi-theme-${theme.key}.png` });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  }
});
