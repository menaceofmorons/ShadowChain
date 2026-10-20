import { expect, test } from '@playwright/test';

test('app shell loads without console errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      problems.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    problems.push(error.message);
  });

  await page.goto('/');
  await expect(page).toHaveTitle('ShadowChain');
  await expect(page.locator('#root')).toBeAttached();
  expect(problems).toEqual([]);
});
