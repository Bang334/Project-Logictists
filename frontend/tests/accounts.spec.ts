import { test, expect, Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
const selectBranch = async (page: Page, code: string) => {
  await page.getByLabel('Chi nhánh được cấp', { exact: true }).click();
  await page.locator('.ant-select-item-option').filter({ hasText: code }).click();
  await page.getByLabel('Chi nhánh được cấp', { exact: true }).press('Escape');
};
const fill = async (page: Page, username: string, branches = ['DEMO-AUTH-A']) => {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Họ tên', { exact: true }).fill('[PLAYWRIGHT ACCOUNTS] ' + username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByLabel('Xác nhận mật khẩu', { exact: true }).fill(password);
  await page.getByLabel('Vai trò', { exact: true }).click();
  await page.locator('.ant-select-item-option').filter({ hasText: 'DISPATCHER' }).click();
  for (const branch of branches) await selectBranch(page, branch);
};
const search = async (page: Page, username: string) => {
  await page.getByRole('searchbox', { name: 'Tìm tài khoản' }).fill(username);
  await page.getByRole('searchbox', { name: 'Tìm tài khoản' }).press('Enter');
};

test('admin creates persisted account; reload, logout and dispatcher scope/cache isolation', async ({ page }) => {
  const username = 'pw_accounts_' + randomUUID().slice(0, 12);
  await page.goto('/'); await login(page, 'demo_auth_admin');
  await page.getByRole('menuitem', { name: 'Quản lý tài khoản', exact: true }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  await page.getByRole('button', { name: 'Tạo tài khoản', exact: true }).click();
  await fill(page, username);
  await page.getByRole('button', { name: 'Lưu tài khoản' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await search(page, username);
  await expect(page.getByRole('row').filter({ hasText: username })).toContainText('[DEMO AUTH] Chi nhánh A');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Quản lý tài khoản', exact: true })).toBeVisible();
  await search(page, username);
  await expect(page.getByRole('row').filter({ hasText: username })).toBeVisible();
  await page.screenshot({ path: 'test-results/accounts-admin.png', fullPage: true });
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await login(page, username);
  await expect(page.getByRole('menuitem', { name: 'Quản lý tài khoản', exact: true })).toHaveCount(0);
  await expect(page.getByText('Không có quyền truy cập', { exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Quản lý Đơn hàng' }).click();
  await page.getByPlaceholder('Tìm theo mã đơn, khách hàng, địa chỉ, hàng hóa...').fill('DEMO-AUTH-ORDER-');
  await expect(page.getByText('DEMO-AUTH-ORDER-A', { exact: true })).toBeVisible();
  await expect(page.getByText('DEMO-AUTH-ORDER-B', { exact: true })).toHaveCount(0);
  await page.goto('/accounts');
  await expect(page.getByText('Không có quyền truy cập', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
});

test('admin creates multiple branch scopes and locks all active browser sessions', async ({ page, browser }) => {
  const username = 'pw_accounts_' + randomUUID().slice(0, 12);
  await page.goto('/accounts'); await login(page, 'demo_auth_admin');
  await page.getByRole('button', { name: 'Tạo tài khoản', exact: true }).click();
  await fill(page, username, ['DEMO-AUTH-A', 'DEMO-AUTH-B']);
  await page.getByRole('button', { name: 'Lưu tài khoản' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await search(page, username);
  const row = page.getByRole('row').filter({ hasText: username });
  await expect(row).toContainText('[DEMO AUTH] Chi nhánh A'); await expect(row).toContainText('[DEMO AUTH] Chi nhánh B');
  const context = await browser.newContext();
  const other = await context.newPage();
  try {
    await other.goto('http://localhost:5173/'); await login(other, username);
    await other.getByRole('menuitem', { name: 'Quản lý Đơn hàng' }).click();
    await other.getByPlaceholder('Tìm theo mã đơn, khách hàng, địa chỉ, hàng hóa...').fill('DEMO-AUTH-ORDER-');
    await expect(other.getByText('DEMO-AUTH-ORDER-A', { exact: true })).toBeVisible();
    await expect(other.getByText('DEMO-AUTH-ORDER-B', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Khóa', exact: true }).click();
    await page.getByRole('button', { name: 'Xác nhận khóa', exact: true }).click();
    await expect(row).toContainText('Đã khóa');
    await expect(row.getByRole('button', { name: 'Khóa', exact: true })).toHaveCount(0);
    await other.reload();
    await expect(other.getByLabel('Tên đăng nhập')).toBeVisible();
    await expect(other.getByRole('menuitem')).toHaveCount(0);
    await expect(other.getByText('DEMO-AUTH-ORDER-A', { exact: true })).toHaveCount(0);
    await page.reload(); await search(page, username);
    await expect(row).toContainText('Đã khóa');
    await search(page, 'demo_auth_admin');
    await expect(page.getByRole('row').filter({ hasText: 'demo_auth_admin' }).getByRole('button', { name: 'Khóa', exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});

test('form validation, duplicate username and backend errors preserve fields and distinguish 403/401', async ({ page }) => {
  await page.goto('/accounts'); await login(page, 'demo_auth_admin');
  await page.getByRole('button', { name: 'Tạo tài khoản', exact: true }).click();
  await page.getByRole('button', { name: 'Lưu tài khoản' }).click();
  await expect(page.getByText('Chọn vai trò', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('Chọn ít nhất một chi nhánh', { exact: true })).toBeVisible();
  await fill(page, 'demo_auth_admin');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('short');
  await page.getByRole('button', { name: 'Lưu tài khoản' }).click();
  await expect(page.getByText('Mật khẩu phải có từ 12 đến 72 byte UTF-8', { exact: true })).toBeVisible();
  await expect(page.getByText('Mật khẩu xác nhận không khớp', { exact: true })).toBeVisible();
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Lưu tài khoản' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Tên đăng nhập đã tồn tại');
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue('demo_auth_admin');
  await page.getByLabel('Username', { exact: true }).fill('pw_accounts_error');
  // Only error-state scenarios simulate failures; successful writes above use real PostgreSQL.
  await page.route('**/users', route => route.abort('connectionrefused'));
  await page.getByRole('button', { name: 'Lưu tài khoản' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Không kết nối được backend');
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue('pw_accounts_error');
  await page.unroute('**/users');
  await page.route('**/users', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'BRANCH_UNAVAILABLE', field: 'branchIds', message: 'Chi nhánh đã ngừng hoạt động' }) }));
  await page.getByRole('button', { name: 'Lưu tài khoản' }).click();
  await expect(page.getByText('Chi nhánh đã ngừng hoạt động', { exact: true }).last()).toBeVisible();
  await page.unroute('**/users');
  // Revalidate the field after server validation before the next submission.
  await selectBranch(page, 'DEMO-AUTH-B');
  await page.route('**/users', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'PERMISSION_DENIED', message: 'Bạn không có quyền tạo tài khoản' }) }));
  await page.getByRole('button', { name: 'Lưu tài khoản' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Bạn không có quyền tạo tài khoản');
  await expect(page.getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
  await page.unroute('**/users');
  await page.route('**/users', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'SESSION_INVALID', message: 'Phiên hết hạn' }) }));
  await page.getByRole('button', { name: 'Lưu tài khoản' }).click();
  await expect(page.getByLabel('Tên đăng nhập')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('list error, empty state, filters and compact viewport remain usable', async ({ page }) => {
  await page.goto('/accounts'); await login(page, 'demo_auth_admin');
  await search(page, 'nonexistent_' + randomUUID());
  await expect(page.getByText('Không có tài khoản phù hợp', { exact: true })).toBeVisible();
  await page.route('**/users?**', route => route.abort('connectionrefused'));
  await page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Không kết nối được backend');
  await page.unroute('**/users?**');
  await page.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expect(page.getByText('Không có tài khoản phù hợp', { exact: true })).toBeVisible();
  await search(page, 'demo_auth');
  await page.getByRole('combobox', { name: 'Lọc trạng thái' }).click();
  await page.locator('.ant-select-item-option').filter({ hasText: 'Đã khóa' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'demo_auth_locked' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'demo_auth_admin' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Tạo tài khoản', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tạo tài khoản', exact: true }).click();
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/accounts-mobile.png', fullPage: true, animations: 'disabled' });
});
