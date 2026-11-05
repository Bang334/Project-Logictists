import { test, expect, Page } from '@playwright/test';
const api = 'http://127.0.0.1:4018';
async function login(page: Page, username = 'demo_auth_admin') {
  await page.goto('/audit-logs');
  await page.getByLabel('Tên đăng nhập').fill(username);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('Order-test-only-2026!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
}
async function fixture(page: Page) {
  const token = await page.evaluate(() => sessionStorage.getItem('tms_token'));
  const headers = { Authorization: 'Bearer ' + token, 'Idempotency-Key': crypto.randomUUID() };
  const branches = await (await page.request.get(api + '/branches', { headers })).json();
  const branch = branches.find((b: { code: string }) => b.code === 'DEMO-AUTH-A');
  const response = await page.request.post(api + '/customers', { headers, data: { name: 'Audit browser ' + crypto.randomUUID(), phone: '000', branchIds: [branch.id] } });
  expect(response.status()).toBe(201);
  return { customer: await response.json(), headers, branch };
}
test('real mutation → lookup → detail → object → Back/reload, timezone and small screen', async ({ page }) => {
  await login(page); await expect(page.getByRole('heading', { name: 'Nhật ký thao tác quản trị' })).toBeVisible();
  const { customer } = await fixture(page);
  await page.getByLabel('ID đối tượng', { exact: true }).fill(customer.id);
  await page.getByRole('button', { name: 'Tra cứu', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Xem nhật ký' })).toHaveCount(1);
  const url = page.url();
  await page.getByRole('button', { name: 'Xem nhật ký' }).click();
  await expect(page.getByText('Chi tiết nhật ký', { exact: true })).toBeVisible();
  await expect(page.getByText('Không có giá trị trước/sau được ghi nhận và được phép hiển thị')).toBeVisible();
  await page.getByRole('link', { name: 'Mở đối tượng' }).click();
  await expect(page.getByText('Hồ sơ khách hàng', { exact: true })).toBeVisible();
  await expect(page.getByText(customer.name, { exact: true }).last()).toBeVisible();
  await page.goBack(); await expect(page.getByText('Chi tiết nhật ký', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('link', { name: 'Mở đối tượng' })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  expect(new URL(page.url()).searchParams.get('entityId')).toBe(customer.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('ID đối tượng', { exact: true }).focus(); await page.keyboard.press('Tab');
  await expect(page.getByLabel('ID chi nhánh đã ghi nhận')).toBeFocused();
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Nhật ký thao tác quản trị' })).toBeVisible();
  await page.screenshot({ path: 'test-results/audit-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url); await expect(page.getByRole('button', { name: 'Xem nhật ký' })).toHaveCount(1);
  await page.screenshot({ path: 'test-results/audit-desktop.png', fullPage: true });
});
test('real order cancellation reason is rendered as text, not HTML', async ({ page }) => {
  await login(page); await expect(page.getByRole('heading', { name: 'Nhật ký thao tác quản trị' })).toBeVisible();
  const { customer, headers, branch } = await fixture(page);
  const response = await page.request.post(api + '/orders', { headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, data: { branchId: branch.id, customerId: customer.id,
    stops: ['PICKUP','DELIVERY'].map((type,i) => ({ type, address: '[AUDIT BROWSER]', latitude: 21+i/100, longitude: 105, contactName: 'Test', contactPhone: '000', windowStart: '2033-01-01T00:00:00Z', windowEnd: '2033-01-02T00:00:00Z', serviceDurationMinutes: 1 })),
    items: [{ description: 'test', packageType: 'CARTON', packages: [{ lengthMm: 400, widthMm: 300, heightMm: 200, weightG: '10000' }] }] } });
  expect(response.status()).toBe(201); const order = await response.json();
  const reason = '<script>window.auditInjected=true</script>';
  expect((await page.request.post(api + '/orders/' + order.id + '/cancel', { headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, data: { version: 1, reason } })).status()).toBe(201);
  await page.getByLabel('ID đối tượng', { exact: true }).fill(order.id); await page.getByRole('button', { name: 'Tra cứu', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Xem nhật ký' })).toHaveCount(2);
  await page.getByRole('row').filter({ hasText: 'Hủy đơn' }).getByRole('button').click();
  await expect(page.getByText(reason, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => 'auditInjected' in window)).toBe(false);
  await page.getByRole('link', { name: 'Mở đối tượng' }).click(); await expect(page.getByText('Lý do: ' + reason, { exact: true })).toBeVisible();
});
test('network failure/retry, empty, detail 404 and 403 discard displayed data (injected error responses)', async ({ page }) => {
  await login(page); await expect(page.getByRole('heading', { name: 'Nhật ký thao tác quản trị' })).toBeVisible();
  const { customer } = await fixture(page);
  await page.getByLabel('ID đối tượng', { exact: true }).fill(customer.id); await page.getByRole('button', { name: 'Tra cứu', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Xem nhật ký' })).toHaveCount(1);
  await page.route('**/audit-logs?*', route => route.abort());
  await page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await expect(page.getByText(/Không kết nối được backend/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Xem nhật ký' })).toHaveCount(0);
  await page.unroute('**/audit-logs?*'); await page.getByRole('button', { name: 'Thử lại', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Xem nhật ký' })).toHaveCount(1);
  await page.route('**/audit-logs/AUDIT_LOG/*', route => route.fulfill({ status: 404, json: { message: 'Không tìm thấy nhật ký kiểm thử' } }));
  await page.getByRole('button', { name: 'Xem nhật ký' }).click(); await expect(page.getByText('Không tìm thấy nhật ký kiểm thử')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('ID đối tượng', { exact: true }).fill(crypto.randomUUID()); await page.getByRole('button', { name: 'Tra cứu', exact: true }).click();
  await expect(page.getByText('Không có nhật ký phù hợp')).toBeVisible();
  await page.route('**/audit-logs?*', route => route.fulfill({ status: 403, json: { message: 'Quyền đọc nhật ký đã bị thu hồi' } }));
  await page.getByRole('button', { name: 'Tải lại', exact: true }).click(); await expect(page.getByText('Quyền đọc nhật ký đã bị thu hồi')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Xem nhật ký' })).toHaveCount(0);
});
test('dispatcher cannot open audit or call API directly', async ({ page }) => {
  await login(page, 'demo_auth_a');
  await expect(page.getByText('Không có quyền truy cập', { exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Nhật ký thao tác' })).toHaveCount(0);
  const token = await page.evaluate(() => sessionStorage.getItem('tms_token'));
  const r = await page.request.get(api + '/audit-logs?from=2032-01-01T00:00:00Z&to=2032-01-02T00:00:00Z', { headers: { Authorization: 'Bearer ' + token } }); expect(r.status()).toBe(403);
});
test('old filter responses, scope change, logout/account switch and 401 clear audit data', async ({ page }) => {
  await login(page); await expect(page.getByRole('heading', { name: 'Nhật ký thao tác quản trị' })).toBeVisible();
  const { customer } = await fixture(page);
  await page.getByLabel('ID đối tượng', { exact: true }).fill(customer.id); await page.getByRole('button', { name: 'Tra cứu', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Xem nhật ký' })).toHaveCount(1);
  // Hold a real successful response to exercise out-of-order delivery, not fake success data.
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let observed = () => {}; const started = new Promise<void>(resolve => { observed = resolve; });
  let completed = () => {}; const finished = new Promise<void>(resolve => { completed = resolve; });
  await page.route('**/audit-logs?*', async route => {
    if (!route.request().url().includes(customer.id)) { await route.continue(); return; }
    const response = await route.fetch(); observed(); await gate; await route.fulfill({ response }); completed();
  });
  await page.getByRole('button', { name: 'Tải lại', exact: true }).click(); await started;
  await page.getByLabel('ID đối tượng', { exact: true }).fill(crypto.randomUUID()); await page.getByRole('button', { name: 'Tra cứu', exact: true }).click();
  await expect(page.getByText('Không có nhật ký phù hợp')).toBeVisible(); release(); await finished; await page.unroute('**/audit-logs?*');
  await expect(page.getByRole('button', { name: 'Xem nhật ký' })).toHaveCount(0);
  await page.getByLabel('ID đối tượng', { exact: true }).fill(customer.id); await page.getByRole('button', { name: 'Tra cứu', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Xem nhật ký' })).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Chi nhánh làm việc' }).fill('[DEMO AUTH] Chi nhánh B');
  const changedScope = page.waitForRequest(r => r.url().includes('/audit-logs?') && !!r.headers()['x-branch-id']);
  await page.getByRole('combobox', { name: 'Chi nhánh làm việc' }).press('Enter');
  await changedScope;
  // ADMIN policy remains company-wide after remount; historical scope still A.
  await expect(page.getByRole('button', { name: 'Xem nhật ký' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Xem nhật ký' })).toHaveCount(0);
  await login(page, 'demo_auth_a'); await expect(page.getByText('Không có quyền truy cập', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click(); await login(page);
  await expect(page.getByRole('heading', { name: 'Nhật ký thao tác quản trị' })).toBeVisible();
  await page.route('**/audit-logs?*', route => route.fulfill({ status: 401, json: { message: 'Phiên hết hạn kiểm thử' } }));
  await page.getByRole('button', { name: 'Tải lại', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Đăng nhập TMS' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Xem nhật ký' })).toHaveCount(0);
});
test('account, branch and vehicle links open the actual protected detail screens', async ({ page }) => {
  await login(page); await expect(page.getByRole('heading', { name: 'Nhật ký thao tác quản trị' })).toBeVisible();
  const { headers, branch } = await fixture(page);
  const suffix = crypto.randomUUID().slice(0,8);
  const account = await page.request.post(api + '/users', { headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, data: { username: 'audit_' + suffix, fullName: 'Audit account ' + suffix, password: 'Audit-test-only-2026!', roleCode: 'DISPATCHER', branchIds: [branch.id] } });
  expect(account.status()).toBe(201); const accountData = await account.json();
  const createdBranch = await page.request.post(api + '/branches', { headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, data: { code: 'AUD-' + suffix, name: 'Audit branch ' + suffix, address: '[TEST] audit', latitude: 21, longitude: 105 } });
  expect(createdBranch.status()).toBe(201); const branchData = await createdBranch.json();
  const vehicles = await (await page.request.get(api + '/fleet/vehicles?page=1&pageSize=1', { headers })).json();
  const vehicle = await (await page.request.get(api + '/vehicles/' + vehicles.items[0].id, { headers })).json();
  expect((await page.request.patch(api + '/vehicles/' + vehicle.id, { headers, data: { expectedUpdatedAt: vehicle.updatedAt, model: 'Audit model ' + suffix } })).status()).toBe(200);
  for (const [id, target, expected] of [[accountData.id, 'accounts', accountData.fullName], [branchData.id, 'branch-detail', branchData.name], [vehicle.id, 'fleet', 'Audit model ' + suffix]]) {
    await page.goto('/audit-logs'); await page.getByLabel('ID đối tượng', { exact: true }).fill(id); await page.getByRole('button', { name: 'Tra cứu', exact: true }).click();
    await page.getByRole('button', { name: 'Xem nhật ký' }).first().click(); await page.getByRole('link', { name: 'Mở đối tượng' }).click();
    await expect(page).toHaveURL(new RegExp('/' + target + '\\?'));
    if (target === 'accounts') await expect(page.getByRole('dialog').getByLabel('Tên hiển thị')).toHaveValue(expected);
    else await expect(page.getByText(expected, { exact: true }).last()).toBeVisible();
    await page.goBack(); await expect(page.getByText('Chi tiết nhật ký', { exact: true })).toBeVisible();
  }
});
