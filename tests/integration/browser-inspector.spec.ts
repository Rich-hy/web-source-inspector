import { expect, test, type Locator, type Page } from '@playwright/test';

const SOURCE_ATTRIBUTE = 'data-wsi-source';
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function inspectorRoot(page: Page): Locator {
  return page.locator('[data-wsi-runtime-root="true"]');
}

function inspectorButton(page: Page): Locator {
  return inspectorRoot(page).getByRole('button', { name: '源码检查器' });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('开发页面注入 Inspector 按钮和源码 marker', async ({ page }) => {
  await expect(inspectorButton(page)).toBeVisible();

  const markedElements = page.locator(`[${SOURCE_ATTRIBUTE}]`);
  await expect(markedElements.first()).toBeVisible();
  expect(await markedElements.count()).toBeGreaterThan(0);
});

test('操作 Inspector 按钮不会触发页面级 pointer 监听', async ({ page }) => {
  await page.evaluate(() => {
    const state = window as typeof window & { __wsiBusinessPointerCount?: number };
    state.__wsiBusinessPointerCount = 0;
    document.addEventListener('pointerdown', () => {
      state.__wsiBusinessPointerCount = (state.__wsiBusinessPointerCount ?? 0) + 1;
    }, true);
  });

  await inspectorButton(page).click();

  await expect(inspectorButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __wsiBusinessPointerCount?: number }).__wsiBusinessPointerCount
  ))).toBe(0);
});

test('v-for 的多个运行时实例共享同一个源码 ID', async ({ page }) => {
  const rows = page.locator('.work-row');
  await expect(rows).toHaveCount(3);

  const sourceIds = await rows.evaluateAll((elements, attributeName) => (
    elements.map((element) => element.getAttribute(attributeName as string))
  ), SOURCE_ATTRIBUTE);

  expect(
    sourceIds.every((sourceId) => typeof sourceId === 'string' && SOURCE_ID_PATTERN.test(sourceId)),
  ).toBe(true);
  expect(new Set(sourceIds).size).toBe(1);
});

test('Teleport 到独立容器后仍保留源码 marker', async ({ page }) => {
  await page.getByRole('button', { name: '打开 Teleport' }).click();

  const dialog = page.getByRole('dialog', { name: 'Teleport 内容' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute(SOURCE_ATTRIBUTE, /.+/);
  await expect(page.locator('#teleport-target')).toContainText('该节点渲染在独立容器中。');
});

test('Shift 命中 inheritAttrs false 多根组件时定位调用方', async ({ page }) => {
  await inspectorButton(page).click();
  await page.keyboard.down('Shift');
  await page.locator('.no-inherit-label').hover();
  await page.keyboard.up('Shift');

  const tooltip = inspectorRoot(page).locator('.wsi-tooltip');
  await expect(tooltip).toHaveAttribute('data-visible', 'true');
  await expect(tooltip.locator('.wsi-title')).toContainText(' · ');
  await expect(tooltip.locator('.wsi-detail')).toHaveText('IDE 未连接');
});

test('选择模式阻止业务点击，Esc 退出后恢复业务交互', async ({ page }) => {
  const button = inspectorButton(page);
  const businessButton = page.getByRole('button', { name: '业务计数' });
  const activityCount = page.getByTestId('activity-count');

  await expect(activityCount).toContainText('0 次业务操作');
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');

  await businessButton.click();
  await expect(activityCount).toContainText('0 次业务操作');

  await page.keyboard.press('Escape');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await businessButton.click();
  await expect(activityCount).toContainText('1 次业务操作');
});

test('tooltip 不展示源码路径、行列或绝对路径', async ({ page }) => {
  await inspectorButton(page).click();
  await page.getByRole('heading', { name: 'Web Source Inspector' }).hover();

  const tooltip = inspectorRoot(page).locator('.wsi-tooltip');
  const detail = tooltip.locator('.wsi-detail');
  await expect(tooltip).toHaveAttribute('data-visible', 'true');
  await expect(detail).toHaveText('IDE 未连接');

  const tooltipText = await tooltip.innerText();
  expect(tooltipText).not.toContain('.vue');
  expect(tooltipText).not.toMatch(/:\d+(?::\d+)?/u);
  expect(tooltipText).not.toMatch(/[A-Za-z]:[\\/]/u);
  expect(tooltipText).not.toMatch(/\\\\[^\\\s]+\\/u);
  expect(tooltipText).not.toMatch(/(?:^|\n)\/(?:Users|home|workspace|mnt|tmp|private|var|opt|root)\//iu);
});
