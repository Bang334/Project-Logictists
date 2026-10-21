import { test, expect, Page } from '@playwright/test';
const url = '/?from=2031-01-01T17%3A00%3A00Z&to=2031-01-02T17%3A00%3A00Z';
async function login(page: Page) {
  const profile = await (await page.request.get('http://127.0.0.1:4020/__test/profile')).json();
  await page.goto(url);
  await page.locator('input[autocomplete="username"]').fill(profile.username);
  await page.locator('input[autocomplete="current-password"]').fill('Dashboard-test-only-2026!');
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('heading', { name: 'Dashboard vận hành vận tải' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Đối chiếu Đơn chờ kiểm tra điều phối', exact: true })).toBeEnabled();
  return profile;
}
const card = (page: Page, name: string) => page.locator('.ant-card').filter({ has: page.getByRole('button', { name: 'Đối chiếu ' + name, exact: true }) }).first();

test('real snapshots, card drilldowns, details, back/reload, keyboard and narrow layout', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const profile = await login(page);
  await expect(card(page,'Đơn chờ kiểm tra điều phối').locator('.ant-statistic-content')).toHaveText('2');
  await expect(card(page,'Chuyến có mốc khởi hành thực tế trong kỳ').locator('.ant-statistic-content')).toHaveText('2');
  await page.getByRole('button', { name: profile.candidate, exact: true }).click();
  await expect(page).toHaveURL(/\/orders\?order=/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Từ ngày giờ')).toHaveValue('2031-01-02T00:00');
  await page.getByRole('button', { name: 'Đối chiếu Chuyến có mốc khởi hành thực tế trong kỳ', exact: true }).click();
  const table = page.locator('#dashboard-trips');
  await expect(table.getByRole('button', { name: /^DASH-TRIP-/ })).toHaveCount(2);
  await table.getByRole('button', { name: /^DASH-TRIP-/ }).first().click();
  await expect(page).toHaveURL(/\/trips\?trip=/);
  await expect(page.locator('.ant-descriptions')).toBeVisible();
  await page.goBack();
  await expect(table.getByRole('button', { name: /^DASH-TRIP-/ })).toHaveCount(2);
  await page.reload();
  await expect(table.getByRole('button', { name: /^DASH-TRIP-/ })).toHaveCount(2);
  await page.getByRole('button', { name: 'Đối chiếu Xe có trạng thái AVAILABLE', exact: true }).click();
  await page.getByRole('button', { name: /^DASH-A-/ }).click();
  await expect(page).toHaveURL(/\/fleet\?kind=vehicles&resource=/);
  await expect(page.locator('.ant-drawer-content')).toBeVisible();
  await page.goBack();
  await page.getByLabel('Từ ngày giờ').focus(); await expect(page.getByLabel('Từ ngày giờ')).toBeFocused();
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Làm mới', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('partial network failure keeps labeled stale snapshot and retry recovers real data', async ({ page }) => {
  await login(page);
  await page.route('**/dashboard/summary?**', route => route.abort('failed'));
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect(page.getByText(/^Dữ liệu cũ —/)).toBeVisible();
  await expect(card(page,'Đơn chờ kiểm tra điều phối').locator('.ant-statistic-content')).toHaveText('2');
  await expect(page.locator('#dashboard-trips').getByRole('button', { name: /^DASH-TRIP-/ })).toHaveCount(7);
  await page.unroute('**/dashboard/summary?**');
  await page.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expect(page.getByText(/^Dữ liệu cũ —/)).toHaveCount(0);
  await page.route('**/dashboard/items?**', route => route.abort('failed'));
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect(page.getByText(/^Dữ liệu cũ —/)).toHaveCount(2);
  await expect(card(page,'Đơn chờ kiểm tra điều phối').locator('.ant-statistic-content')).toHaveText('2');
});

test('late response cannot overwrite new period; real socket duplicates and reconnect invalidate', async ({ page, context, request }) => {
  await login(page);
  let release: () => void = () => {}, started: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const intercepted = new Promise<void>(resolve => { started = resolve; });
  let delayed = false;
  await page.route('**/dashboard/summary?**', async route => {
    if (delayed) return route.continue();
    delayed = true; const response = await route.fetch(); started(); await held; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click(); await intercepted;
  await page.getByLabel('Từ ngày giờ').fill('2031-01-03T00:00');
  await page.getByLabel('Đến ngày giờ').fill('2031-01-04T00:00');
  await expect(card(page,'Chuyến có mốc khởi hành thực tế trong kỳ').locator('.ant-statistic-content')).toHaveText('1');
  release();
  await expect(card(page,'Chuyến có mốc khởi hành thực tế trong kỳ').locator('.ant-statistic-content')).toHaveText('1');
  await expect(page.getByText('Đã kết nối thông báo chuyến; API là nguồn dữ liệu. Hồ sơ/đơn được tải lại định kỳ.')).toBeVisible();
  await request.post('http://127.0.0.1:4020/__test/notify');
  await expect(card(page,'Chuyến đang thực hiện').locator('.ant-statistic-content')).toHaveText('0');
  await expect(card(page,'Chuyến đã phát hành').locator('.ant-statistic-content')).toHaveText('2');
  await context.setOffline(true);
  await expect(page.getByText('Snapshot từ server; tự tải lại mỗi 30–60 giây khi trang hiển thị.')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('Đã kết nối thông báo chuyến; API là nguồn dữ liệu. Hồ sơ/đơn được tải lại định kỳ.')).toBeVisible();
  await expect(card(page,'Chuyến đã phát hành').locator('.ant-statistic-content')).toHaveText('2');
});

test('scope changes and account switch clear old data; revocation clears protected snapshots', async ({ page }) => {
  const profile = await login(page);
  await page.request.post('http://127.0.0.1:4020/__test/revoke');
  await expect(page.getByRole('button', { name: profile.candidate, exact: true })).toHaveCount(0);
  await expect(card(page,'Đơn chờ kiểm tra điều phối').locator('.ant-statistic-content')).not.toHaveText('2');
  // Login through the real form to a different branch; no token injection.
  await page.locator('.tms-logout-button').click();
  await page.locator('input[autocomplete="username"]').fill(profile.otherUsername);
  await page.locator('input[autocomplete="current-password"]').fill('Dashboard-test-only-2026!');
  await page.locator('button[type="submit"]').click();
  await expect(card(page,'Đơn chờ kiểm tra điều phối').locator('.ant-statistic-content')).toHaveText('1');
  await expect(page.getByRole('button', { name: profile.candidate, exact: true })).toHaveCount(0);
  await page.reload();
  await expect(card(page,'Đơn chờ kiểm tra điều phối').locator('.ant-statistic-content')).toHaveText('1');
});

test('two authorized branches: selection, delayed old response, all scope and reload persistence', async ({ page }) => {
  const profile = await (await page.request.get('http://127.0.0.1:4020/__test/profile')).json();
  await page.goto(url);
  await page.locator('input[autocomplete="username"]').fill(profile.multiUsername);
  await page.locator('input[autocomplete="current-password"]').fill('Dashboard-test-only-2026!');
  await page.locator('button[type="submit"]').click();
  await expect(card(page,'Đơn chờ kiểm tra điều phối').locator('.ant-statistic-content')).toHaveText('3');
  let release: () => void = () => {}, started: () => void = () => {};
  const held = new Promise<void>(r => { release = r; }), intercepted = new Promise<void>(r => { started = r; });
  let delayed = false;
  await page.route('**/dashboard/summary?**', async route => {
    if (delayed) return route.continue();
    delayed = true; const response = await route.fetch(); started(); await held; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click(); await intercepted;
  await page.getByRole('combobox', { name: 'Chi nhánh Dashboard', exact: true }).press('ArrowDown');
  await page.locator('.ant-select-item-option').filter({ hasText: '[DASH TEST] B' }).click();
  await expect(card(page,'Đơn chờ kiểm tra điều phối').locator('.ant-statistic-content')).toHaveText('1');
  release();
  await expect(card(page,'Đơn chờ kiểm tra điều phối').locator('.ant-statistic-content')).toHaveText('1');
  await page.reload();
  await expect(card(page,'Đơn chờ kiểm tra điều phối').locator('.ant-statistic-content')).toHaveText('1');
  await page.getByRole('combobox', { name: 'Chi nhánh Dashboard', exact: true }).press('ArrowDown');
  await page.locator('.ant-select-item-option').filter({ hasText: 'Tất cả chi nhánh được cấp' }).click();
  await expect(card(page,'Đơn chờ kiểm tra điều phối').locator('.ant-statistic-content')).toHaveText('3');
});
