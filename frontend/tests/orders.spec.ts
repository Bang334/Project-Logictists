import { test, expect, Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const config = require('../../backend/node_modules/dotenv').parse(readFileSync('../backend/.env'));
const login = async (page: Page) => {
  await page.goto('/');
  await page.getByLabel('Tên đăng nhập').fill('demo_auth_a');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(config.AUTH_DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
  await page.goto('/orders');
  await expect(page.getByRole('heading', { name: 'Quản lý đơn hàng', exact: true })).toBeVisible();
};
async function fillOrder(page: Page, description: string) {
  await page.getByRole('button', { name: 'Tạo đơn nháp' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Khách hàng', { exact: true }).click();
  await page.locator('.ant-select-item-option').filter({ hasText: 'DEMO-AUTH-CUSTOMER-A' }).click();
  for (let i = 0; i < 2; i++) {
    await form.getByLabel('Địa chỉ', { exact: true }).nth(i).fill('[PLAYWRIGHT] Hà Nội ' + i);
    await form.getByLabel('Vĩ độ', { exact: true }).nth(i).fill(i === 0 ? '21.03' : '21.04');
    await form.getByLabel('Kinh độ', { exact: true }).nth(i).fill('105.85');
    await form.getByLabel('Người liên hệ', { exact: true }).nth(i).fill('Test');
    await form.getByLabel('Điện thoại', { exact: true }).nth(i).fill('000');
    const start = form.getByLabel('Bắt đầu khung giờ (UTC+7)', { exact: true }).nth(i);
    await start.fill('01/01/2031 23:00'); await start.press('Enter'); await start.press('Tab');
    const end = form.getByLabel('Kết thúc khung giờ (UTC+7)', { exact: true }).nth(i);
    await end.fill('02/01/2031 04:00'); await end.press('Enter'); await end.press('Tab');
  }
  await form.getByLabel('Mô tả hàng', { exact: true }).fill(description);
  await form.getByLabel('Dài mỗi kiện (mm)', { exact: true }).fill('401');
  await form.getByLabel('Rộng mỗi kiện (mm)', { exact: true }).fill('302');
  await form.getByLabel('Cao mỗi kiện (mm)', { exact: true }).fill('203');
  await form.getByLabel('Khối lượng mỗi kiện (g)', { exact: true }).fill('10001');
  await form.getByRole('button', { name: 'Thêm N kiện theo số đo kiện đầu' }).click();
  await form.getByLabel('Khối lượng mỗi kiện (g)', { exact: true }).nth(1).fill('20002');
  return form;
}
test('real create, Package detail, reload, edit stable IDs and confirm', async ({ page }) => {
  await login(page);
  const form = await fillOrder(page, '[PLAYWRIGHT] ' + randomUUID());
  const style = page.waitForResponse(r => r.url().includes('api.mapbox.com/styles/v1/mapbox/streets-v12') && r.status() === 200);
  await form.getByRole('button', { name: 'Chọn điểm lấy trên Mapbox', exact: true }).click();
  await style;
  const picker = page.getByRole('dialog', { name: 'Chọn Vị Trí Trên Bản Đồ' });
  const canvas = picker.locator('.mapboxgl-canvas');
  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 210, y: 160 } });
  await picker.getByLabel('Địa chỉ điểm đã chọn', { exact: true }).fill('[PLAYWRIGHT] Điểm đã chọn trên Mapbox');
  await picker.getByRole('button', { name: 'Xác nhận vị trí này' }).click();
  await expect(picker).not.toBeVisible();
  await expect(form.getByLabel('Địa chỉ', { exact: true }).first()).toHaveValue('[PLAYWRIGHT] Điểm đã chọn trên Mapbox');
  const latitude = Number(await form.getByLabel('Vĩ độ', { exact: true }).first().inputValue());
  expect(latitude).not.toBe(21.03);
  const createdResponse = page.waitForResponse(r => r.url().endsWith('/orders') && r.request().method() === 'POST');
  await form.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
  const response = await createdResponse; expect(response.status()).toBe(201);
  const order = await response.json();
  expect(order.totalPackages).toBe(2); expect(order.totalWeightG).toBe('30003');
  expect(order.stops[0].windowStart).toBe('2031-01-01T16:00:00.000Z');
  expect(order.stops[0].latitude).toBe(latitude);
  await expect(page.getByText('Từng kiện đã lưu', { exact: true })).toBeVisible();
  await expect(page.getByText(order.items[0].packages[0].packageCode, { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('searchbox', { name: 'Tìm đơn', exact: true }).fill(order.orderNumber);
  await page.getByRole('searchbox', { name: 'Tìm đơn', exact: true }).press('Enter');
  const row = page.getByRole('row').filter({ hasText: order.orderNumber });
  await row.getByRole('button', { name: 'Chi tiết', exact: true }).click();
  await expect(page.getByText(order.items[0].packages[0].packageCode, { exact: true })).toBeVisible();
  await page.getByRole('dialog').screenshot({ path: 'test-results/orders-detail.png' });
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await row.getByRole('button', { name: 'Sửa', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Khối lượng mỗi kiện (g)', { exact: true }).first().fill('15001');
  const update = page.waitForResponse(r => r.url().endsWith('/orders/' + order.id) && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  const saved = await (await update).json();
  expect(saved.items[0].packages.map((p: { id: string }) => p.id)).toEqual(order.items[0].packages.map((p: { id: string }) => p.id));
  expect(saved.totalWeightG).toBe((BigInt(order.totalWeightG) - BigInt(order.items[0].packages[0].weightG) + 15001n).toString());
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await row.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('CONFIRMED', { exact: true })).toBeVisible();
});
test('network and field errors preserve form, retry reuses key, forbidden response visible', async ({ page }) => {
  await login(page);
  const description = '[PLAYWRIGHT ERROR] ' + randomUUID();
  const form = await fillOrder(page, description);
  let key: string | undefined;
  await page.route('**/orders', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    key = route.request().headers()['idempotency-key']; await route.abort('failed');
  });
  await form.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(form.getByText('Không kết nối được backend. Vui lòng kiểm tra kết nối và thử lại.', { exact: true })).toBeVisible();
  await expect(form.getByLabel('Mô tả hàng', { exact: true })).toHaveValue(description);
  await page.unroute('**/orders');
  await page.route('**/orders', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    expect(route.request().headers()['idempotency-key']).toBe(key);
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Kiểm tra số đo', fieldErrors: [{ field: 'items.0.packages.0.lengthMm', message: 'Số đo cần kiểm tra' }] }) });
  });
  await form.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(form.getByText('Số đo cần kiểm tra', { exact: true })).toBeVisible();
  await page.unroute('**/orders');
  await form.getByLabel('Dài mỗi kiện (mm)', { exact: true }).first().fill('402');
  await page.route('**/orders', route => route.request().method() === 'POST' ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'PERMISSION_DENIED', message: 'Không có quyền lưu đơn' }) }) : route.continue());
  await form.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(form.getByText('Không có quyền lưu đơn', { exact: true })).toBeVisible();
  await expect(form.getByLabel('Mô tả hàng', { exact: true })).toHaveValue(description);
});
test('small viewport and keyboard input', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole('button', { name: 'Tạo đơn nháp' }).click();
  const form = page.getByRole('dialog');
  const desc = form.getByLabel('Mô tả hàng', { exact: true });
  await desc.focus(); await desc.pressSequentially('Keyboard package'); await desc.press('Tab');
  await expect(desc).toHaveValue('Keyboard package');
  const box = await form.boundingBox(); if (!box) throw new Error('Missing visible dialog'); expect(box.width).toBeLessThanOrEqual(390); expect(box.height).toBeLessThanOrEqual(844);
  await form.getByRole('button', { name: 'Lưu nháp', exact: true }).scrollIntoViewIfNeeded();
  await expect(form.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'test-results/orders-mobile.png' });
});

test('dispatch shows unresolved legacy load instead of retaining a previous load profile', async ({ page }) => {
  await login(page);
  await page.route('**/trips/*/load-profile', route => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ code: 'LEGACY_LOAD_REVIEW_REQUIRED', message: 'Phân công cũ cần đối soát kiện để tính tải' }) }));
  await page.getByRole('menuitem', { name: 'Điều Phối Thủ Công' }).click();
  await expect(page.getByText('Phân công cũ cần đối soát kiện để tính tải', { exact: true })).toBeVisible();
  await expect(page.getByText('Phân Tích Tải Trọng Từng Chặng (Stop-by-Stop Load Profile)', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expect(page.getByText('Phân công cũ cần đối soát kiện để tính tải', { exact: true })).toBeVisible();
});
