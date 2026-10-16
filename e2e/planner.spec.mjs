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

  test('a project picks the node pools it is on', async ({ page }) => {
    const dialog = page.locator('#add-dialog');
    const row = page.locator('.row[data-queue="workspace-rtx"]');
    await row.getByRole('button', { name: 'node pools…' }).click();
    await expect(dialog.getByRole('heading', { name: 'Node pools of project workspace' })).toBeVisible();
    // Its queue in the source cannot be taken away here.
    const onRtx = dialog.getByRole('checkbox', { name: 'workspace on rtx-pro-6000' });
    await expect(onRtx).toBeChecked();
    await expect(onRtx).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // A second pool, which the department is given a queue on first.
    await page.locator('#add-kinds [data-add="NodePool"]').click();
    await dialog.locator('[name="name"]').fill('h100');
    await dialog.locator('[name="labelValue"]').fill('h100');
    await dialog.getByRole('button', { name: 'Add to the plan' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Queue on another pool' }).click();
    await dialog.locator('[name="owner"]').selectOption('Department/platform');
    await dialog.locator('[name="pool"]').selectOption('h100');
    await dialog.getByRole('button', { name: 'Add to the plan' }).click();
    await expect(dialog).toBeHidden();

    // Now the project can be put on it from its own row.
    await row.getByRole('button', { name: 'node pools…' }).click();
    const onH100 = dialog.getByRole('checkbox', { name: 'workspace on h100' });
    await expect(onH100).toBeEnabled();
    await onH100.check();
    await expect(dialog.locator('[name="queue/h100"]')).toHaveValue('workspace-h100');
    await dialog.locator('[name="deserved/h100"]').fill('2');
    await dialog.getByRole('button', { name: 'Update the plan' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#changes')).toContainText('new queue for project workspace: workspace-h100');
    await expect(page.locator('.row[data-queue="workspace-h100"]')).toBeVisible();

    // And taken off it again: the planned queue goes, the source one stays.
    await row.getByRole('button', { name: 'node pools…' }).click();
    await expect(dialog.getByRole('checkbox', { name: 'workspace on h100' })).toBeChecked();
    await dialog.getByRole('checkbox', { name: 'workspace on h100' }).uncheck();
    await dialog.getByRole('button', { name: 'Update the plan' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#changes')).not.toContainText('workspace-h100');
    await expect(page.locator('.row[data-queue="workspace-h100"]')).toHaveCount(0);
    await expect(page.locator('.row[data-queue="workspace-rtx"]')).toBeVisible();
  });

  test('theme toggle switches color scheme', async ({ page }) => {
    const root = page.locator('html');
    const before = await root.evaluate((el) => el.dataset.theme ?? '');
    await page.getByRole('button', { name: 'Switch between light and dark' }).click();
    const after = await root.evaluate((el) => el.dataset.theme ?? '');
    expect(after).not.toBe(before);
  });
});
