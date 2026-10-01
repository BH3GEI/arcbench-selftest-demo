// Demo test pack for the GitHub Actions grader template.
// Same conventions as the rest of the repo: BASE_URL comes from the
// environment (the runner container sets it to the isolated app address),
// navigation only through visible UI, no implementation knowledge assumed.
import { test, expect } from '@playwright/test';

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.beforeEach(async ({ page }) => {
  await page.goto(baseUrl);
});

test('shows the Todos heading', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Todos', exact: true })).toBeVisible();
});

test('adds a todo and keeps it after reload', async ({ page }) => {
  await page.getByLabel('What needs to be done?', { exact: true }).fill('write the demo');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('write the demo', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('write the demo', { exact: true })).toBeVisible();
});

test('rejects an empty title', async ({ page }) => {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Title is required', { exact: true })).toBeVisible();
});

test('deletes a todo', async ({ page }) => {
  await page.getByLabel('What needs to be done?', { exact: true }).fill('ship it');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const item = page.locator('li', { hasText: 'ship it' });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('ship it', { exact: true })).toHaveCount(0);
});

test('keeps several todos after reload', async ({ page }) => {
  await page.getByLabel('What needs to be done?', { exact: true }).fill('first task');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('What needs to be done?', { exact: true }).fill('second task');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.reload();
  await expect(page.getByText('first task', { exact: true })).toBeVisible();
  await expect(page.getByText('second task', { exact: true })).toBeVisible();
});
