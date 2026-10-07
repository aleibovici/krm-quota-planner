import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eDir = dirname(fileURLToPath(import.meta.url));
const fixtureEnv = () => JSON.parse(readFileSync(join(e2eDir, '.fixture-env.json'), 'utf8'));

async function waitForPlan(page) {
  await page.waitForResponse((r) => r.url().includes('/api/plan') && r.request().method() === 'POST' && r.ok());
}

test.describe('GPU quota planner (git mode)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'GPU quota planner', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'rtx-pro-6000', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Department platform/i })).toBeVisible();
  });

  test('loads tenancy and shows an empty plan', async ({ page }) => {
    await expect(page.locator('#changes')).toContainText('No changes yet');
    await expect(page.getByRole('button', { name: 'Review and commit' })).toBeDisabled();
    await expect(page.locator('#diff')).toContainText('The files are unchanged');
  });

  test('editing a quota updates changes, diff, and enables commit', async ({ page }) => {
    const guaranteed = page.getByRole('spinbutton', { name: /Guaranteed for benchmark-rtx/i });
    await guaranteed.fill('0.5');
    await waitForPlan(page);

    await expect(page.locator('#changes')).not.toContainText('No changes yet');
    await expect(page.locator('#diff')).toContainText('benchmark-rtx');
    await expect(page.getByRole('button', { name: 'Review and commit' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Copy diff' })).toBeEnabled();
  });

  test('oversubscribing the department shows an error and blocks commit', async ({ page }) => {
    await page.getByRole('spinbutton', { name: /Guaranteed for workspace-rtx/i }).fill('4');
    await waitForPlan(page);
    await page.getByRole('spinbutton', { name: /Guaranteed for benchmark-rtx/i }).fill('2');
    await waitForPlan(page);

    await expect(page.locator('#findings')).toContainText(/error/i);
    await expect(page.getByRole('button', { name: 'Review and commit' })).toBeDisabled();
    // The department says so on its own line, and so does the pool it is on.
    await expect(page.locator('.dept[data-dept="platform"] .dept-flags')).toContainText('2 over');
    await expect(page.locator('.pool[data-pool="rtx-pro-6000"] .pool-flags')).toContainText(/error/);
    await expect(page.locator('.ov[data-ov="rtx-pro-6000"]')).toContainText(/error/);
  });

  test('a closed department still shows its numbers and can be changed', async ({ page }) => {
    const department = page.locator('.dept[data-dept="platform"]');
    await page.getByRole('button', { name: /Department platform/i }).click();
    await expect(department.locator('.dept-body')).toBeHidden();
    await expect(department.locator('.meter-text')).toContainText('to 3 projects');

    await page.getByRole('spinbutton', { name: /Guaranteed for platform-rtx/i }).fill('6');
    await waitForPlan(page);
    await expect(page.locator('#changes')).toContainText('platform-rtx');
    await expect(department.locator('.dept-body')).toBeHidden();
  });

  test('"Only issues" leaves what needs attention', async ({ page }) => {
    const pool = page.locator('.pool[data-pool="rtx-pro-6000"]');
    await page.getByRole('button', { name: 'Only issues' }).click();
    await expect(pool).toBeHidden();
    await expect(page.locator('#no-issues')).toBeVisible();

    await page.getByRole('button', { name: 'Only issues' }).click();
    await page.getByRole('spinbutton', { name: /Guaranteed for workspace-rtx/i }).fill('4');
    await waitForPlan(page);
    await page.getByRole('button', { name: 'Only issues' }).click();
    await expect(pool).toBeVisible();
    await expect(page.locator('#no-issues')).toBeHidden();
    await expect(page.locator('.row[data-queue="workspace-rtx"] .row-flag')).toBeVisible();

    // Typing the fix must not take the row away mid-number.
    const guaranteed = page.getByRole('spinbutton', { name: /Guaranteed for workspace-rtx/i });
    await guaranteed.focus();
    await guaranteed.press('ControlOrMeta+a');
    await guaranteed.pressSequentially('3');
    await waitForPlan(page);
    await expect(page.locator('#findings')).toContainText('Nothing in the way');
    await expect(guaranteed).toBeVisible();
    await expect(guaranteed).toBeFocused();
  });

  test('creates a local commit from the UI', async ({ page }) => {
    const { repo } = fixtureEnv();
    await page.getByRole('spinbutton', { name: /Guaranteed for benchmark-rtx/i }).fill('0.5');
    await waitForPlan(page);

    await page.getByRole('button', { name: 'Review and commit' }).click();
    await expect(page.getByRole('heading', { name: 'Commit to a new branch' })).toBeVisible();

    await page.locator('#branch').fill('e2e/quota-test');
    await page.getByRole('button', { name: 'Create local commit' }).click();
    await expect(page.locator('#commit-output')).toContainText('e2e/quota-test');
    await expect(page.locator('#commit-output')).toContainText('created at');

    const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'e2e/quota-test'], { encoding: 'utf8' }).trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const tenancy = execFileSync('git', ['-C', repo, 'show', `${sha}:services/kai-scheduler/manifests/tenancy.yaml`], { encoding: 'utf8' });
    expect(tenancy).toMatch(/deserved: 0\.5/);
  });

  test('reload keeps edits and replans', async ({ page }) => {
    await page.getByRole('spinbutton', { name: /Guaranteed for benchmark-rtx/i }).fill('0.75');
    await waitForPlan(page);
    const plan = page.waitForResponse((r) => r.url().includes('/api/reload') && r.ok());
    await page.getByRole('button', { name: 'Reload' }).click();
    await plan;
    await expect(page.locator('#changes')).not.toContainText('No changes yet');
    await expect(page.getByRole('button', { name: 'Review and commit' })).toBeEnabled();
  });

  test('theme toggle switches color scheme', async ({ page }) => {
    const root = page.locator('html');
    const before = await root.evaluate((el) => el.dataset.theme ?? '');
    await page.getByRole('button', { name: 'Switch between light and dark' }).click();
    const after = await root.evaluate((el) => el.dataset.theme ?? '');
    expect(after).not.toBe(before);
  });
});
