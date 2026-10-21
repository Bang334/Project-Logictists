import { test, expect, Page } from '@playwright/test';
async function login(page: Page, username = 'demo_auth_admin') {
  await page.goto('/fleet'); await page.getByLabel('Tên đăng nhập').fill(username); await page.getByLabel('Mật khẩu', { exact: true }).fill('Fleet-test-only-2026!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Xe, tài xế và lịch khả dụng' })).toBeVisible();
}
async function find(page: Page, value: string) { await page.getByLabel('Tìm hồ sơ').fill(value); await page.getByLabel('Tìm hồ sơ').press('Enter'); await expect(page.getByRole('row').filter({ hasText: value }).first()).toBeVisible(); }
test('real create vehicle, schedule, availability and reload; narrow screen', async ({ page }) => {
  await login(page); const plate = 'UI' + Date.now();
  await page.getByRole('button', { name: 'Tạo xe', exact: true }).click(); const modal = page.getByRole('dialog', { name: 'Tạo xe', exact: true });
  await modal.getByLabel('Biển số', { exact: true }).fill(plate); await modal.getByLabel('Dòng xe', { exact: true }).fill('UI model');
  await modal.getByLabel('Loại xe — tải và số đo dùng chung').click(); await page.locator('.ant-select-item-option-content').filter({ hasText: 'Fleet UI Type' }).click();
  await modal.getByLabel('Chi nhánh quản lý', { exact: true }).click(); await page.locator('.ant-select-item-option-content').filter({ hasText: '[DEMO AUTH] Chi nhánh A' }).click();
  await modal.getByRole('button', { name: 'Lưu hồ sơ' }).click(); await expect(modal).toBeHidden(); await page.reload(); await find(page, plate);
  await page.getByRole('row').filter({ hasText: plate }).getByRole('button', { name: 'Chi tiết / lịch' }).click();
  await page.getByRole('button', { name: 'Thêm lịch', exact: true }).click(); const schedule = page.getByRole('dialog', { name: 'Thêm lịch' });
  const inputs = schedule.locator('.ant-picker-range input'); const today = new Date(); const tomorrow = new Date(today.getTime() + 86400000); const format = (d: Date) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  await inputs.nth(0).fill(format(today) + ' 22:00'); await inputs.nth(0).press('Tab'); await inputs.nth(1).fill(format(tomorrow) + ' 02:00'); await inputs.nth(1).press('Tab');
  await schedule.getByLabel('Lý do', { exact: true }).fill('UI overnight maintenance'); await schedule.getByRole('button', { name: 'Lưu lịch' }).click(); await expect(schedule).toBeHidden();
  await expect(page.getByRole('cell', { name: 'UI overnight maintenance', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await page.getByRole('button', { name: 'Tra cứu theo thời gian' }).click();
  await expect(page.getByText('Cửa/vật cản chưa được kiểm chứng')).toBeVisible(); await page.reload(); await find(page, plate);
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Tạo xe', exact: true }).click();
  const retry = page.getByRole('dialog', { name: 'Tạo xe', exact: true }); await retry.getByLabel('Biển số', { exact: true }).fill('UNSAVED');
  await expect(retry.getByLabel('Biển số', { exact: true })).toHaveValue('UNSAVED');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/fleet-mobile.png', animations: 'disabled' });
});
test('create driver from Employee, edit, reload and preserve form on API conflict', async ({ page }) => {
  await login(page); await page.getByRole('tab', { name: 'Tài xế', exact: true }).click(); await page.getByRole('button', { name: 'Tạo tài xế', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Tạo tài xế từ Employee' });
  const employee = modal.getByLabel('Nhân viên chưa có hồ sơ tài xế'); await employee.fill('Fleet UI Employee');
  const choice = page.locator('.ant-select-item-option-content').filter({ hasText: 'Fleet UI Employee' }).first(); await expect(choice).toBeVisible(); const employeeName = (await choice.innerText()).split('·')[1].trim(); await choice.click();
  await modal.getByLabel('Số giấy phép', { exact: true }).fill('UI-LIC-' + Date.now()); await modal.getByLabel('Hạng giấy phép (theo hồ sơ)').fill('C');
  const expiry = modal.getByLabel('Ngày hết hạn (hết ngày giờ Việt Nam)'); await expiry.fill('01/01/2035'); await expiry.press('Enter');
  await modal.getByRole('button', { name: 'Lưu hồ sơ' }).click(); await expect(modal).toBeHidden(); await page.reload(); await page.getByRole('tab', { name: 'Tài xế', exact: true }).click(); await find(page, employeeName);
  await page.getByRole('row').filter({ hasText: employeeName }).getByRole('button', { name: 'Sửa', exact: true }).click(); const edit = page.getByRole('dialog').filter({ hasText: 'Chỉnh Sửa Hồ Sơ' });
  await edit.getByLabel('Số Điện Thoại Liên Hệ').fill('222'); await edit.getByRole('button', { name: 'Lưu Hồ Sơ' }).click(); await expect(edit).toBeHidden();
  await page.reload(); await page.getByRole('tab', { name: 'Tài xế', exact: true }).click(); await find(page, employeeName); await page.getByRole('row').filter({ hasText: employeeName }).getByRole('button', { name: 'Sửa', exact: true }).click();
  await expect(edit.getByLabel('Số Điện Thoại Liên Hệ')).toHaveValue('222'); await edit.getByLabel('Số Điện Thoại Liên Hệ').fill('Unsaved phone');
  await page.route('**/drivers/*', route => route.request().method() === 'PATCH' ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'RESOURCE_VERSION_CONFLICT', message: 'Hồ sơ đã thay đổi. Tải lại và đối chiếu trước khi lưu.' }) }) : route.continue());
  await edit.getByRole('button', { name: 'Lưu Hồ Sơ' }).click(); await expect(page.getByText('Hồ sơ đã thay đổi. Tải lại và đối chiếu trước khi lưu.')).toBeVisible(); await expect(edit.getByLabel('Số Điện Thoại Liên Hệ')).toHaveValue('Unsaved phone');
});
test('dispatcher is read-only and another branch cannot retain previous resources', async ({ page }) => {
  await login(page, 'demo_auth_a'); await expect(page.getByRole('button', { name: 'Tạo xe', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Tài xế', exact: true }).click(); await expect(page.getByRole('button', { name: 'Tạo tài xế', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click(); await login(page, 'demo_auth_b');
  await page.getByLabel('Tìm hồ sơ').fill('UI'); await page.getByLabel('Tìm hồ sơ').press('Enter'); await expect(page.getByRole('cell').filter({ hasText: /^UI\d+$/ })).toHaveCount(0);
});
