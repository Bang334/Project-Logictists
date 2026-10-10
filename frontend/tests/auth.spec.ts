import { test, expect, Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const config = require('../../backend/node_modules/dotenv').parse(readFileSync('../backend/.env'));
const password: string = config.AUTH_DEMO_PASSWORD;
if (!password) throw new Error('AUTH_DEMO_PASSWORD is required in backend/.env');
const login = async (page: Page, username: string) => {
  await page.getByLabel('Tên đăng nhập').fill(username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
};
test('real login → reload → navigation → logout → different account isolates cached data', async ({ page }) => {
  await page.goto('/'); await login(page, 'demo_auth_a');
  await page.getByRole('menuitem', { name: 'Quản lý Đơn hàng' }).click();
  await page.getByPlaceholder('Tìm theo mã đơn, khách hàng, địa chỉ, hàng hóa...').fill('DEMO-AUTH-ORDER-');
  await expect(page.getByText('DEMO-AUTH-ORDER-A', { exact: true })).toBeVisible();
  await expect(page.getByText('DEMO-AUTH-ORDER-B', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Đội Xe & Tài Xế' }).click();
  await expect(page.getByRole('button', { name: /Sửa/ }).first()).toBeDisabled();
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page.getByLabel('Tên đăng nhập')).toBeVisible();
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  await login(page, 'demo_auth_b');
  await page.getByRole('menuitem', { name: 'Quản lý Đơn hàng' }).click();
  await page.getByPlaceholder('Tìm theo mã đơn, khách hàng, địa chỉ, hàng hóa...').fill('DEMO-AUTH-ORDER-');
  await expect(page.getByText('DEMO-AUTH-ORDER-B', { exact: true })).toBeVisible();
  await expect(page.getByText('DEMO-AUTH-ORDER-A', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/dispatcher-b.png' });
});
test('admin changes working branch without retaining the previous branch orders', async ({ page }) => {
  await page.goto('/'); await login(page, 'demo_auth_admin');
  await page.getByRole('menuitem', { name: 'Quản lý Đơn hàng' }).click();
  // Repeated integration runs leave valid test orders; locate both fixtures through the real UI filter.
  await page.getByPlaceholder('Tìm theo mã đơn, khách hàng, địa chỉ, hàng hóa...').fill('DEMO-AUTH-ORDER-');
  await expect(page.getByText('DEMO-AUTH-ORDER-A', { exact: true })).toBeVisible();
  await expect(page.getByText('DEMO-AUTH-ORDER-B', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Chi nhánh làm việc' }).focus();
  await page.getByRole('combobox', { name: 'Chi nhánh làm việc' }).press('ArrowDown');
  await page.getByTitle('[DEMO AUTH] Chi nhánh A', { exact: true }).last().click();
  await page.getByPlaceholder('Tìm theo mã đơn, khách hàng, địa chỉ, hàng hóa...').fill('DEMO-AUTH-ORDER-');
  await expect(page.getByText('DEMO-AUTH-ORDER-A', { exact: true })).toBeVisible();
  await expect(page.getByText('DEMO-AUTH-ORDER-B', { exact: true })).toHaveCount(0);
});
test('wrong credentials and unavailable backend show different messages', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Tên đăng nhập').fill('demo_auth_a');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('incorrect');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Sai tên đăng nhập hoặc mật khẩu');
  // Network failure is simulated only for this UI error-state test.
  await page.route('**/auth/login', route => route.abort('connectionrefused'));
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Không kết nối được backend');
});
test('403 keeps session; 401 removes protected content', async ({ page }) => {
  await page.goto('/'); await login(page, 'demo_auth_a');
  await page.route('**/orders*', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'PERMISSION_DENIED', message: 'Thiếu quyền' }) }));
  await page.getByRole('menuitem', { name: 'Quản lý Đơn hàng' }).click();
  await expect(page.getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
  await page.unroute('**/orders*');
  await page.route('**/auth/profile', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'SESSION_INVALID', message: 'Phiên hết hạn' }) }));
  await page.reload();
  await expect(page.getByLabel('Tên đăng nhập')).toBeVisible();
  await expect(page.getByRole('menuitem')).toHaveCount(0);
});
