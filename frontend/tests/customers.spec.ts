import { test, expect, Page } from '@playwright/test';
const password = 'Customer-test-only-2026!';
const login = async (page: Page, username = 'demo_auth_a') => {
  await page.goto('/customers'); await page.getByLabel('Tên đăng nhập').fill(username); await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Khách hàng vận tải', exact: true })).toBeVisible();
};
const find = async (page: Page, name: string) => { await page.getByLabel('Tìm khách hàng').fill(name); await page.getByLabel('Tìm khách hàng').press('Enter'); await expect(page.getByRole('row').filter({ hasText: name }).first()).toBeVisible(); };

test('create → reload → first order → edit → reload; selected customer beyond first lookup page', async ({ page }) => {
  const name = 'ZZZ UI customer '+Date.now(); await login(page);
  await page.getByRole('button', { name: 'Tạo khách hàng', exact: true }).click();
  const modal=page.getByRole('dialog', { name: 'Tạo khách hàng vận tải' });
  await modal.getByLabel('Tên khách hàng', { exact: true }).fill(name); await modal.getByLabel('Điện thoại', { exact: true }).fill('+84 900 ext 2');
  await modal.getByLabel('Người liên hệ').fill('UI Contact'); await modal.getByLabel('Địa chỉ', { exact: true }).fill('Profile address');
  await modal.getByRole('button', { name: 'Lưu khách hàng' }).click(); await expect(modal).toBeHidden();
  await expect(page.getByText('Đã lưu hồ sơ khách hàng trên server')).toBeVisible(); await page.reload(); await find(page,name);
  const row=page.getByRole('row').filter({hasText:name}); await row.getByRole('button',{name:'Sửa',exact:true}).click();
  const edit=page.getByRole('dialog',{name:'Sửa khách hàng vận tải'});await edit.getByLabel('Người liên hệ').fill('Edited contact');await edit.getByRole('button',{name:'Lưu khách hàng'}).click();await expect(edit).toBeHidden();
  await page.reload();await find(page,name);await page.getByRole('row').filter({hasText:name}).getByRole('button',{name:'Chi tiết'}).click();await expect(page.getByText('Edited contact',{exact:true}).last()).toBeVisible();
  await page.goto('/orders');await page.getByRole('button',{name:'Tạo đơn nháp'}).click();const form=page.getByRole('dialog',{name:'Tạo đơn nháp'});
  const select=form.getByRole('combobox',{name:'Khách hàng',exact:true});await select.fill(name);await expect(page.getByRole('option',{name:new RegExp(name)})).toBeAttached();await select.press('ArrowDown');await select.press('Enter');
  await form.getByLabel('Địa chỉ',{exact:true}).nth(0).fill('Pickup snapshot');await form.getByLabel('Địa chỉ',{exact:true}).nth(1).fill('Delivery snapshot');
  await form.getByLabel('Vĩ độ',{exact:true}).nth(0).fill('21');await form.getByLabel('Vĩ độ',{exact:true}).nth(1).fill('21.1');
  await form.getByLabel('Kinh độ',{exact:true}).nth(0).fill('105');await form.getByLabel('Kinh độ',{exact:true}).nth(1).fill('105.1');
  await form.getByLabel('Người liên hệ',{exact:true}).nth(0).fill('Sender');await form.getByLabel('Người liên hệ',{exact:true}).nth(1).fill('Receiver');
  await form.getByLabel('Điện thoại',{exact:true}).nth(0).fill('111');await form.getByLabel('Điện thoại',{exact:true}).nth(1).fill('222');
  await form.getByLabel('Mô tả hàng').fill('Cargo UI');
  await form.getByLabel('Dài mỗi kiện (mm)').fill('100');await form.getByLabel('Rộng mỗi kiện (mm)').fill('100');await form.getByLabel('Cao mỗi kiện (mm)').fill('100');await form.getByLabel('Khối lượng mỗi kiện (g)').fill('1000');
  await form.getByRole('button',{name:'Lưu nháp',exact:true}).click();await expect(form).toBeHidden();await page.reload();
  await page.getByLabel('Tìm đơn').fill(name);await page.getByLabel('Tìm đơn').press('Enter');const orderRow=page.getByRole('row').filter({hasText:name});await expect(orderRow).toBeVisible();
  await orderRow.getByRole('button',{name:'Sửa',exact:true}).click();await expect(page.getByRole('dialog').getByText(new RegExp(name))).toBeVisible();
  await page.screenshot({path:'test-results/customers-order-edit.png'});
});

test('network and server validation errors retain form; conflict requires reload; mobile keyboard layout',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);await page.getByRole('button',{name:'Tạo khách hàng',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'Tạo khách hàng vận tải'});const name='UI errors '+Date.now();await modal.getByLabel('Tên khách hàng',{exact:true}).fill(name);await modal.getByLabel('Điện thoại',{exact:true}).fill('not-unique');
  await page.route('**/customers',route=>route.request().method()==='POST'?route.abort():route.continue());await modal.getByRole('button',{name:'Lưu khách hàng'}).click();await expect(modal.getByText(/Không kết nối được backend/)).toBeVisible();await expect(modal.getByLabel('Tên khách hàng',{exact:true})).toHaveValue(name);await page.unroute('**/customers');
  await page.route('**/customers',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:'VALIDATION_ERROR',message:'Dữ liệu nhập chưa hợp lệ',fieldErrors:[{field:'phone',message:'Điện thoại chưa hợp lệ'}]})}));
  await modal.getByRole('button',{name:'Lưu khách hàng'}).click();await expect(modal.getByText('Điện thoại chưa hợp lệ')).toBeVisible();await expect(modal.getByLabel('Tên khách hàng',{exact:true})).toHaveValue(name);await page.unroute('**/customers');
  await modal.getByLabel('Điện thoại',{exact:true}).fill('repeat-phone');await modal.getByLabel('Tên khách hàng',{exact:true}).focus();await page.keyboard.press('Tab');await expect(modal.getByLabel('Điện thoại',{exact:true})).toBeFocused();
  await modal.getByRole('button',{name:'Lưu khách hàng'}).click();await expect(modal).toBeHidden();await page.reload();await find(page,name);
  await page.getByRole('row').filter({hasText:name}).getByRole('button',{name:'Sửa',exact:true}).click();const edit=page.getByRole('dialog',{name:'Sửa khách hàng vận tải'});await edit.getByLabel('Người liên hệ').fill('Pending changes');
  await page.route('**/customers/*',route=>route.request().method()==='PATCH'?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'CUSTOMER_VERSION_CONFLICT',message:'Khách hàng đã được sửa. Tải lại hồ sơ để đối chiếu trước khi lưu'})}):route.continue());
  await edit.getByRole('button',{name:'Lưu khách hàng'}).click();await expect(edit.getByText(/Khách hàng đã được sửa/)).toBeVisible();await expect(edit.getByLabel('Người liên hệ')).toHaveValue('Pending changes');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'test-results/customers-mobile.png'});
});

test('logout and cross-branch account do not retain previous customer data',async({page})=>{
  await login(page);const name='Private A '+Date.now();await page.getByRole('button',{name:'Tạo khách hàng',exact:true}).click();const modal=page.getByRole('dialog',{name:'Tạo khách hàng vận tải'});await modal.getByLabel('Tên khách hàng',{exact:true}).fill(name);await modal.getByLabel('Điện thoại',{exact:true}).fill('repeat-phone');await modal.getByRole('button',{name:'Lưu khách hàng'}).click();await expect(modal).toBeHidden();
  await page.reload();await page.getByRole('button',{name:'Đăng xuất',exact:true}).click();await login(page,'demo_auth_b');await page.getByLabel('Tìm khách hàng').fill(name);await page.getByLabel('Tìm khách hàng').press('Enter');await expect(page.getByText('Chưa có khách hàng phù hợp')).toBeVisible();await expect(page.getByRole('row').filter({hasText:name})).toHaveCount(0);
});

test('list 403 and detail 404 show errors; changing order branch clears customer',async({page})=>{
  await login(page,'demo_auth_admin');
  await page.route('**/customers/page?**',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'PERMISSION_DENIED',message:'Không có quyền xem khách trong phạm vi này'})}));
  await page.getByRole('button',{name:'Tải lại',exact:true}).click();await expect(page.getByText('Không có quyền xem khách trong phạm vi này')).toBeVisible();await page.unroute('**/customers/page?**');
  await page.getByRole('button',{name:'Thử lại',exact:true}).click();await expect(page.getByRole('button',{name:'Chi tiết',exact:true}).first()).toBeVisible();
  await page.route(/\/customers\/[0-9a-f-]+(?:\?|$)/,route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({code:'CUSTOMER_NOT_FOUND',message:'Khách hàng không tồn tại hoặc ngoài phạm vi được cấp'})}));
  await page.getByRole('button',{name:'Chi tiết',exact:true}).first().click();await expect(page.getByText('Khách hàng không tồn tại hoặc ngoài phạm vi được cấp')).toBeVisible();await page.unroute(/\/customers\/[0-9a-f-]+(?:\?|$)/);
  await page.goto('/orders');await page.getByRole('button',{name:'Tạo đơn nháp'}).click();const form=page.getByRole('dialog',{name:'Tạo đơn nháp'});
  await form.getByRole('combobox',{name:'Chi nhánh quản lý'}).click();await page.locator('.ant-select-item-option-content').filter({hasText:'[DEMO AUTH] Chi nhánh A'}).click();
  const customer=form.getByRole('combobox',{name:'Khách hàng',exact:true});await customer.fill('DEMO-AUTH-CUSTOMER-A');await expect(page.getByRole('option',{name:/DEMO-AUTH-CUSTOMER-A/})).toBeAttached();await customer.press('ArrowDown');await customer.press('Enter');await expect(form.getByTitle(/DEMO-AUTH-CUSTOMER-A/)).toBeVisible();
  await form.getByRole('combobox',{name:'Chi nhánh quản lý'}).focus();await form.getByRole('combobox',{name:'Chi nhánh quản lý'}).press('Enter');await page.locator('.ant-select-item-option-content').filter({hasText:'[DEMO AUTH] Chi nhánh B'}).click();await expect(form.getByTitle(/DEMO-AUTH-CUSTOMER-A/)).toHaveCount(0);
});
