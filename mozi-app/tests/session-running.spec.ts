import { expect, test } from '@playwright/test';

test('central palette keeps background running badge after switching and catalog refresh', async ({ page }) => {
  await page.addInitScript(() => {
    const at = new Date().toISOString();
    const sessions = ['会话1', '会话2'].map((title, index) => ({ sessionId: `s${index + 1}`, title, createdAt: at, updatedAt: at }));
    const run = { id: 'run1', sessionId: 's1', userMessageId: 'u1', status: 'running', createdAt: at, updatedAt: at };
    sessionStorage.setItem('mozi.agent.sessionId', 's1');
    Object.assign(window, { mozi: { agent: {
      getRuntimeState: async () => ({ ok: true, result: { state: 'ready' } }),
      onRuntimeState: () => () => {}, onEvent: () => () => {},
      getModelSettings: async () => ({ ok: true, result: { providers: [] } }),
      listSessions: async () => ({ ok: true, result: { items: sessions.map(session => ({ ...session })) } }),
      getRun: async () => ({ ok: true, result: { ...run, status: sessionStorage.getItem('finished') ? 'completed' : 'running' } }),
      subscribeSession: async ({ sessionId }: { sessionId: string }) => ({ ok: true, result: { sessionId, subscriptionId: `sub-${sessionId}` } }),
      unsubscribeSession: async () => ({ ok: true, result: { removed: true } }),
      getSessionSnapshot: async ({ sessionId }: { sessionId: string }) => ({ ok: true, result: {
        session: sessions.find(s => s.sessionId === sessionId), messages: [], runs: sessionId === 's1' ? [run] : [], tools: [], approvals: [], lastSeq: 0,
      } }),
    } } });
  });
  await page.goto('/mozi_app/chat');
  await expect(page.getByRole('heading', { name: '会话1', exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  const panel = page.getByRole('dialog', { name: '切换会话', exact: true });
  const first = panel.getByRole('option').filter({ hasText: '会话1' });
  await expect(first.getByLabel('正在运行')).toBeVisible();
  await panel.getByRole('option').filter({ hasText: '会话2' }).click();
  await expect(page.getByRole('heading', { name: '会话2', exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(first.getByLabel('正在运行')).toBeVisible();
  await page.waitForTimeout(2300);
  await expect(first.getByLabel('正在运行')).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem('finished', '1'));
  await expect(first.getByLabel('正在运行')).toHaveCount(0, { timeout: 6000 });
  await expect(first).toBeVisible();
});
