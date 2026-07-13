import { expect, test, type Page, type Response } from '@playwright/test';

const SOURCE_ATTRIBUTE = 'data-wsi-source';
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const WDS_SESSION_PATH_PATTERN = /\/__wsi\/[A-Za-z0-9_-]{24}/u;

function isWdsResponse(response: Response, suffix: string): boolean {
  const url = new URL(response.url());
  return WDS_SESSION_PATH_PATTERN.test(url.pathname) && url.pathname.endsWith(suffix);
}

function isBrowserEventResponse(response: Response, event: string): boolean {
  if (!isWdsResponse(response, '/message')) {
    return false;
  }
  const postData = response.request().postData();
  if (!postData) {
    return false;
  }
  try {
    return (JSON.parse(postData) as { event?: unknown }).event === event;
  } catch {
    return false;
  }
}

function inspectorButton(page: Page) {
  return page
    .locator('[data-wsi-runtime-root="true"]')
    .getByRole('button', { name: '源码检查器' });
}

test('Webpack 页面完成 Loader、Runtime 与 WDS 链路', async ({ page }) => {
  const streamResponsePromise = page.waitForResponse(
    (response) => isWdsResponse(response, '/stream/open') && response.status() === 200,
  );
  const helloResponsePromise = page.waitForResponse(
    (response) => isBrowserEventResponse(response, 'wsi:browser:hello') && response.status() === 204,
  );

  await page.goto('/');
  await expect(page).toHaveTitle('Web Source Inspector Webpack Fixture');
  const heading = page.getByRole('heading', { name: 'Webpack Source Inspector' });
  await expect(heading).toBeVisible();

  const listItems = page.locator('li');
  await expect(listItems).toHaveText(['loader', 'runtime', 'bridge']);
  const sourceIds = await listItems.evaluateAll((elements, attributeName) => (
    elements.map((element) => element.getAttribute(attributeName as string))
  ), SOURCE_ATTRIBUTE);
  expect(
    sourceIds.every((sourceId) => typeof sourceId === 'string' && SOURCE_ID_PATTERN.test(sourceId)),
  ).toBe(true);
  expect(new Set(sourceIds).size).toBe(1);

  const businessButton = page.getByRole('button', { name: /业务计数/u });
  await expect(businessButton).toHaveText('业务计数 0');
  await businessButton.click();
  await expect(businessButton).toHaveText('业务计数 1');

  const button = inspectorButton(page);
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('title', '源码检查器 · IDE 未连接');
  await streamResponsePromise;
  await helloResponsePromise;

  const metadataResponsePromise = page.waitForResponse(
    (response) => (
      isBrowserEventResponse(response, 'wsi:browser:metadata-request') &&
      response.status() === 204
    ),
  );
  await button.click();
  await heading.hover();
  await metadataResponsePromise;

  const tooltip = page.locator('[data-wsi-runtime-root="true"] .wsi-tooltip');
  await expect(tooltip).toHaveAttribute('data-visible', 'true');
  await expect(tooltip.locator('.wsi-title')).toContainText(' · ');
  await expect(tooltip.locator('.wsi-detail')).toHaveText('IDE 未连接');
});
