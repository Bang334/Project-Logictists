import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function setup(page: Page, confirmed = true) {
  await page.goto('/orders');
  await page.getByLabel('Tên đăng nhập').fill('demo_auth_a');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('Order-test-only-2026!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem('tms_token'));
  const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() };
  const profile = await (await page.request.get('http://127.0.0.1:4018/auth/profile', { headers })).json();
  const branchId = profile.branches[0].id;
  const customers = await (await page.request.get(`http://127.0.0.1:4018/customers/lookup?branchId=${branchId}&page=1&pageSize=25`, { headers })).json();
  const customerId = customers.items.find((c: { code: string }) => c.code === 'DEMO-AUTH-CUSTOMER-A').id;
  const created = await page.request.post('http://127.0.0.1:4018/orders', { headers, data: {
    branchId, customerId, stops: ['PICKUP','DELIVERY'].map((type, i) => ({ type, address: '[PLAYWRIGHT CANCEL]', latitude: 21 + i / 100, longitude: 105, contactName: 'Test', contactPhone: '000', windowStart: '2031-01-01T00:00:00Z', windowEnd: '2031-01-02T00:00:00Z', serviceDurationMinutes: 1 })),
    items: [{ description: '[PLAYWRIGHT CANCEL]', packageType: 'CARTON', packages: [{ lengthMm: 400, widthMm: 300, heightMm: 200, weightG: '10000' }] }],
  } });
  expect(created.status()).toBe(201); let order = await created.json();
  if (confirmed) {
    const result = await page.request.post(`http://127.0.0.1:4018/orders/${order.id}/confirm`, { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { version: order.version } });
    expect(result.status()).toBe(201); order = await result.json();
  }
  await page.goto(`/orders?order=${order.id}`);
  await page.getByRole('button', { name: 'Hủy đơn', exact: true }).click();
  return { order, headers, dialog: page.getByRole('dialog', { name: 'Hủy đơn vận tải' }) };
}

test('confirmed cancellation, validation, double submit, real reload and candidate exclusion', async ({ page }) => {
  const { order, headers, dialog } = await setup(page);
  await expect(dialog.getByText(order.orderNumber, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Xác nhận hủy đơn' }).click();
  await expect(dialog.getByText('Nhập lý do hủy', { exact: true })).toBeVisible();
  await dialog.getByLabel('Lý do hủy').fill('Khách thay đổi kế hoạch');
  let requests = 0;
  await page.route(`**/orders/${order.id}/cancel`, async route => { requests++; await new Promise(resolve => setTimeout(resolve, 350)); await route.continue(); });
  const response = page.waitForResponse(r => r.url().endsWith(`/${order.id}/cancel`));
  await dialog.getByRole('button', { name: 'Xác nhận hủy đơn' }).dblclick();
  expect((await response).status()).toBe(201);
  await expect(page.getByText('Đơn đã hủy', { exact: true })).toBeVisible();
  expect(requests).toBe(1);
  await page.reload();
  await expect(page.getByText('Lý do: Khách thay đổi kế hoạch', { exact: true })).toBeVisible();
  await expect(page.getByText(/Người hủy:/)).toBeVisible();
  await expect(page.getByText(/Thời điểm:/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hủy đơn', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Chỉnh Sửa Đơn' })).toHaveCount(0);
  const candidates = await page.request.get('http://127.0.0.1:4018/orders/available-for-dispatch', { headers });
  expect(candidates.status()).toBe(200); expect((await candidates.json()).some((o: { id: string }) => o.id === order.id)).toBe(false);
  await page.screenshot({ path: 'test-results/order-cancellation-desktop.png', fullPage: true });
});

test('network failure retains reason and retry key; 403 stays visible', async ({ page }) => {
  const { order, dialog } = await setup(page, false);
  await dialog.getByLabel('Lý do hủy').fill('Giữ lại lý do khi lỗi');
  let key: string | undefined;
  await page.route(`**/orders/${order.id}/cancel`, async route => { key = route.request().headers()['idempotency-key']; await route.abort(); });
  await dialog.getByRole('button', { name: 'Xác nhận hủy đơn' }).click();
  await expect(dialog.getByText(/Không kết nối được backend/)).toBeVisible();
  await expect(dialog.getByLabel('Lý do hủy')).toHaveValue('Giữ lại lý do khi lỗi');
  await page.unroute(`**/orders/${order.id}/cancel`);
  await page.route(`**/orders/${order.id}/cancel`, async route => {
    expect(route.request().headers()['idempotency-key']).toBe(key);
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'PERMISSION_DENIED', message: 'Không có quyền hủy trong phạm vi này' }) });
  });
  await dialog.getByRole('button', { name: 'Xác nhận hủy đơn' }).click();
  await expect(dialog.getByText('Không có quyền hủy trong phạm vi này')).toBeVisible();
  await expect(dialog.getByLabel('Lý do hủy')).toHaveValue('Giữ lại lý do khi lỗi');
  await page.unroute(`**/orders/${order.id}/cancel`);
  await dialog.getByRole('button', { name: 'Xác nhận hủy đơn' }).click();
  await expect(page.getByText('Đơn đã hủy', { exact: true })).toBeVisible();
});

test('real stale version requires explicit reload and does not resubmit', async ({ page }) => {
  const { order, headers, dialog } = await setup(page, false);
  await dialog.getByLabel('Lý do hủy').fill('Lý do từ màn hình cũ');
  const confirmed = await page.request.post(`http://127.0.0.1:4018/orders/${order.id}/confirm`, { headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { version: order.version } });
  expect(confirmed.status()).toBe(201);
  let requests = 0; page.on('request', r => { if (r.url().endsWith(`/${order.id}/cancel`)) requests++; });
  await dialog.getByRole('button', { name: 'Xác nhận hủy đơn' }).click();
  await expect(dialog.getByText(/Đơn đã thay đổi/)).toBeVisible();
  await expect(dialog.getByLabel('Lý do hủy')).toHaveValue('Lý do từ màn hình cũ');
  await expect(dialog.getByRole('button', { name: 'Xác nhận hủy đơn' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Tải lại để đối chiếu' }).click();
  await expect(page.getByRole('dialog').getByText('CONFIRMED', { exact: true })).toBeVisible();
  expect(requests).toBe(1);
});

test('mobile keyboard and expired session clear protected content', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { order, dialog } = await setup(page);
  await dialog.getByLabel('Lý do hủy').focus();
  await expect(dialog.getByLabel('Lý do hủy')).toBeFocused();
  await page.keyboard.type('Keyboard cancellation');
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Xác nhận hủy đơn' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/order-cancellation-mobile.png', fullPage: true });
  await page.route(`**/orders/${order.id}/cancel`, route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Phiên hết hạn' }) }));
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Tên đăng nhập')).toBeVisible();
  await expect(page.getByText(order.orderNumber, { exact: true })).toHaveCount(0);
});

test('switch account and branch cannot retain the previous order or cancellation reason', async ({ page }) => {
  const { order, dialog } = await setup(page);
  await dialog.getByLabel('Lý do hủy').fill('Nội dung riêng của chi nhánh A');
  await dialog.getByRole('button', { name: 'Đóng', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Đóng', exact: true }).click();
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await page.getByLabel('Tên đăng nhập').fill('demo_auth_admin');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('Order-test-only-2026!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
  await page.goto('/orders');
  const branch = page.getByRole('combobox', { name: 'Chi nhánh làm việc', exact: true });
  await branch.fill('[DEMO AUTH] Chi nhánh B');
  await page.locator('.ant-select-item-option').filter({ hasText: '[DEMO AUTH] Chi nhánh B' }).click();
  await expect(page.getByText('Nội dung riêng của chi nhánh A', { exact: true })).toHaveCount(0);
  await expect(page.getByText(order.orderNumber, { exact: true })).toHaveCount(0);
  await page.goto(`/orders?order=${order.id}`);
  await expect(page.getByText('Đơn không tồn tại hoặc ngoài phạm vi', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hủy đơn', exact: true })).toHaveCount(0);
});

test('automatic dispatch selector and dashboard reflect real cancellation after refresh', async ({ page }) => {
  const { order } = await setup(page);
  const candidates = () => page.waitForResponse(r => r.url().includes('/orders/available-for-dispatch') && r.status() === 200);
  let response = candidates();
  await page.goto('/dispatch-auto');
  const before = await (await response).json();
  expect(before.some((o: { id: string }) => o.id === order.id)).toBe(true);
  await expect(page.getByRole('tab', { name: `Đơn hàng sẵn sàng (${before.length})`, exact: false })).toBeVisible();
  const summaryBefore = page.waitForResponse(r => r.url().includes('/dashboard/summary') && r.status() === 200);
  await page.goto('/dashboard');
  const countBefore = (await (await summaryBefore).json()).metrics.candidateOrders;
  const card = page.locator('.ant-statistic').filter({ hasText: 'Đơn chờ kiểm tra điều phối' });
  await expect(card.locator('.ant-statistic-content-value')).toHaveText(String(countBefore));
  await page.goto(`/orders?order=${order.id}`);
  await page.getByRole('button', { name: 'Hủy đơn', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Hủy đơn vận tải' });
  await dialog.getByLabel('Lý do hủy').fill('Đối chiếu ứng viên');
  await dialog.getByRole('button', { name: 'Xác nhận hủy đơn' }).click();
  await expect(page.getByText('Đơn đã hủy', { exact: true })).toBeVisible();
  response = candidates();
  await page.goto('/dispatch-auto');
  const after = await (await response).json();
  expect(after.some((o: { id: string }) => o.id === order.id)).toBe(false);
  expect(after).toHaveLength(before.length - 1);
  await expect(page.getByRole('tab', { name: `Đơn hàng sẵn sàng (${after.length})`, exact: false })).toBeVisible();
  const summaryAfter = page.waitForResponse(r => r.url().includes('/dashboard/summary') && r.status() === 200);
  await page.goto('/dashboard');
  expect((await (await summaryAfter).json()).metrics.candidateOrders).toBe(countBefore - 1);
  await expect(card.locator('.ant-statistic-content-value')).toHaveText(String(countBefore - 1));
});
