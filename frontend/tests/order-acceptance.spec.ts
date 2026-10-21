import { test, expect, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const login = async (page: Page) => {
  await page.goto('/orders');
  await page.getByLabel('Tên đăng nhập').fill('demo_auth_a');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('Order-test-only-2026!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
  await page.goto('/orders');
  await expect(page.getByRole('heading', { name: 'Quản lý đơn hàng', exact: true })).toBeVisible();
};
async function fillOrder(page: Page, description: string) {
  await page.getByRole('button', { name: 'Tạo đơn nháp' }).click();
  const form = page.getByRole('dialog');
  await form.getByRole('combobox', { name: 'Khách hàng', exact: true }).click();
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
async function saveReloadEditConfirm(page: Page, latitude: number) {
  const form = page.getByRole('dialog');
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
}

test('explicit coordinates save, reload, preserve Package IDs and confirm', async ({ page }) => {
  await login(page);
  await fillOrder(page, '[PLAYWRIGHT DIRECT] ' + randomUUID());
  await saveReloadEditConfirm(page, 21.03);
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
  await page.screenshot({ path: 'test-results/order-acceptance-mobile.png', animations: 'disabled' });
});

test('editing notes preserves millisecond windows; confirmed manifest survives login and dispatch handoff', async ({ page }) => {
  await login(page);
  const token = await page.evaluate(() => sessionStorage.getItem('tms_token'));
  const headers = { Authorization: `Bearer ${token}` };
  const branches = await (await page.request.get('http://127.0.0.1:4018/branches', { headers })).json();
  const branchId = branches[0].id;
  const customerPage = await (await page.request.get('http://127.0.0.1:4018/customers/lookup?branchId=' + branchId, { headers })).json();
  const input = { branchId, customerId: customerPage.items[0].id, notes: '[ACCEPTANCE] milliseconds', stops: ['PICKUP', 'DELIVERY'].map((type, index) => ({ type, address: '[TEST] point', latitude: 21.03, longitude: 105.85, contactName: 'Test', contactPhone: '000', windowStart: '2031-01-01T23:00:00.123+07:00', windowEnd: '2031-01-02T04:00:00.987+07:00', serviceDurationMinutes: index + 1 })), items: [{ description: 'Milliseconds regression', packageType: 'CRATE', packages: [{ lengthMm: 401, widthMm: 302, heightMm: 203, weightG: '10001' }] }] };
  const response = await page.request.post('http://127.0.0.1:4018/orders', { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: input }); expect(response.status()).toBe(201); const order = await response.json();
  await page.reload(); await page.getByRole('searchbox', { name: 'Tìm đơn', exact: true }).fill(order.orderNumber); await page.getByRole('searchbox', { name: 'Tìm đơn', exact: true }).press('Enter');
  const row = page.getByRole('row').filter({ hasText: order.orderNumber }); await row.getByRole('button', { name: 'Sửa', exact: true }).click();
  const form = page.getByRole('dialog'); await form.getByLabel('Ghi chú', { exact: true }).fill('[ACCEPTANCE] notes only');
  const update = page.waitForResponse(r => r.url().endsWith('/orders/' + order.id) && r.request().method() === 'PATCH');
  await form.getByRole('button', { name: 'Lưu thay đổi' }).click(); const saved = await (await update).json();
  expect(saved.stops.map((s: { windowStart: string; windowEnd: string }) => [s.windowStart, s.windowEnd])).toEqual(order.stops.map((s: { windowStart: string; windowEnd: string }) => [s.windowStart, s.windowEnd]));
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await row.getByRole('button', { name: 'Xác nhận', exact: true }).click(); await expect(page.getByRole('dialog').getByText('CONFIRMED', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click(); await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click(); await login(page);
  const newToken = await page.evaluate(() => sessionStorage.getItem('tms_token'));
  const handoff = await page.request.get('http://127.0.0.1:4018/orders/available-for-dispatch', { headers: { Authorization: `Bearer ${newToken}` } }); expect(handoff.status()).toBe(200);
  const entry = (await handoff.json()).find((o: { id: string }) => o.id === order.id); expect(entry.items[0].packages[0].id).toBe(order.items[0].packages[0].id); expect(entry.stops[0].windowStart).toBe(order.stops[0].windowStart);
});

test('save is disabled while pending; version conflict preserves edits and account switch clears previous data', async ({ page }) => {
  await login(page); const form = await fillOrder(page, '[ACCEPTANCE] pending ' + randomUUID());
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }); let count = 0;
  await page.route('**/orders', async route => { if (route.request().method() !== 'POST') return route.continue(); count++; await gate; await route.continue(); });
  const response = page.waitForResponse(r => r.url().endsWith('/orders') && r.request().method() === 'POST');
  await form.getByRole('button', { name: 'Lưu nháp', exact: true }).click(); await expect(form.getByLabel('Mô tả hàng', { exact: true })).toBeDisabled();
  await expect.poll(() => count).toBe(1); release(); const saved = await (await response).json(); await page.unroute('**/orders');
  await expect(page.getByText('Từng kiện đã lưu', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Tìm đơn', exact: true }).fill(saved.orderNumber); await page.getByRole('searchbox', { name: 'Tìm đơn', exact: true }).press('Enter');
  await page.getByRole('row').filter({ hasText: saved.orderNumber }).getByRole('button', { name: 'Sửa', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Ghi chú', { exact: true }).fill('Unsaved conflict');
  await page.route('**/orders/' + saved.id, route => route.request().method() === 'PATCH' ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'ORDER_VERSION_CONFLICT', message: 'Đơn đã thay đổi. Tải lại để đối chiếu trước khi lưu' }) }) : route.continue());
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click(); await expect(page.getByRole('dialog').getByText('Đơn đã thay đổi. Tải lại để đối chiếu trước khi lưu')).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Ghi chú', { exact: true })).toHaveValue('Unsaved conflict');
  await page.getByRole('dialog').getByRole('button', { name: 'Đóng', exact: true }).click();
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click(); await page.getByLabel('Tên đăng nhập').fill('demo_auth_b'); await page.getByLabel('Mật khẩu', { exact: true }).fill('Order-test-only-2026!'); await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Đăng xuất', exact: true })).toBeVisible(); await page.goto('/orders'); await expect(page.getByRole('heading', { name: 'Quản lý đơn hàng', exact: true })).toBeVisible(); await expect(page.getByText(saved.orderNumber, { exact: true })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Tìm đơn', exact: true }).fill(saved.orderNumber); await page.getByRole('searchbox', { name: 'Tìm đơn', exact: true }).press('Enter'); await expect(page.getByText('Chưa có đơn phù hợp')).toBeVisible();
});

