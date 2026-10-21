const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { customerTestApp } = require('./customer-test-app.cjs');
const { PrismaService } = require('../dist/src/prisma/prisma.service');

test('Transport customers: real PostgreSQL and HTTP', { timeout: 180000 }, async t => {
  const app = await customerTestApp(); const db = app.get(PrismaService), base = await app.getUrl();
  const req = async (path, token, method='GET', body, key, branchId) => {
    const r = await fetch(base+path, { method, headers: { ...(token ? { Authorization: 'Bearer '+token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...(branchId ? { 'X-Branch-Id': branchId } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status:r.status, body:await r.json() };
  };
  const login = async name => { const r=await req('/auth/login',null,'POST',{username:name,password:process.env.AUTH_DEMO_PASSWORD});assert.equal(r.status,200);return r.body.accessToken; };
  try {
    const admin=await login('demo_auth_admin'), aToken=await login('demo_auth_a'), bToken=await login('demo_auth_b');
    const a=await db.branch.findUniqueOrThrow({where:{code:'DEMO-AUTH-A'}}), b=await db.branch.findUniqueOrThrow({where:{code:'DEMO-AUTH-B'}});
    const name='[CUSTOMER TEST] '+randomUUID();const input={name:'  '+name+'  ',phone:'  +84 900 ext 2  ',email:'client@example.test',contactPerson:'Contact',address:'Original profile address',branchIds:[a.id]};
    let c, order;
    const orderInput=(customerId,branchId)=>({customerId,branchId,stops:[{type:'PICKUP',address:'Original pickup',latitude:21,longitude:105,contactName:'Sender snapshot',contactPhone:'111',serviceDurationMinutes:5},{type:'DELIVERY',address:'Original delivery',latitude:21.1,longitude:105.1,contactName:'Receiver snapshot',contactPhone:'222',serviceDurationMinutes:5}],items:[{description:'Test cargo',packageType:'CARTON',packages:[{lengthMm:10,widthMm:20,heightMm:30,weightG:'100'}]}]});
    const edit=(profile,extra={})=>({name:profile.name,phone:profile.phone,email:profile.email,address:profile.address,contactPerson:profile.contactPerson,taxCode:profile.taxCode,version:profile.version,...extra});
    await t.test('create, normalize, reload, no-order lookup and first transport order', async()=>{
      const r=await req('/customers',aToken,'POST',input,randomUUID());assert.equal(r.status,201,JSON.stringify(r.body));c=r.body;
      assert.equal(c.name,name);assert.equal(c.phone,'+84 900 ext 2');assert.equal(c.version,1);assert.equal(c.canEdit,true);
      assert.equal(await db.order.count({where:{customerId:c.id}}),0);
      const lookup=await req('/customers/lookup?branchId='+a.id+'&search='+encodeURIComponent(name),aToken);assert.equal(lookup.status,200);assert.equal(lookup.body.items[0].id,c.id);
      assert.equal((await req('/customers/'+c.id,aToken)).body.name,name);
      const created=await req('/orders',aToken,'POST',orderInput(c.id,a.id),randomUUID());assert.equal(created.status,201,JSON.stringify(created.body));order=created.body;assert.equal(order.customerId,c.id);
    });
    await t.test('duplicates of contact phone are allowed; concurrent retry creates once',async()=>{
      const key=randomUUID(), body={...input,name:name+' retry'};
      const results=await Promise.all([req('/customers',aToken,'POST',body,key),req('/customers',aToken,'POST',body,key)]);
      results.forEach(r=>assert.equal(r.status,201,JSON.stringify(r.body)));assert.equal(results[0].body.id,results[1].body.id);assert.notEqual(results[0].body.id,c.id);
      assert.equal((await req('/customers',aToken,'POST',{...body,name:'changed'},key)).status,409);
      assert.equal(await db.customer.count({where:{name:body.name}}),1);
    });
    await t.test('outside scope, forged branches, internal fields, missing auth and invalid input',async()=>{
      assert.equal((await req('/customers/'+c.id,bToken)).status,404);
      assert.equal((await req('/customers/'+c.id,bToken,'PATCH',edit(c),randomUUID())).status,404);
      assert.equal((await req('/customers/page?branchId='+a.id,bToken)).status,403);
      assert.equal((await req('/customers',aToken,'POST',{...input,branchIds:[b.id]},randomUUID())).status,403);
      assert.equal((await req('/customers',aToken,'POST',{...input,userId:randomUUID()},randomUUID())).status,400);
      assert.equal((await req('/customers',aToken,'POST',{...input,name:' '},randomUUID())).status,400);
      assert.equal((await req('/customers',aToken,'POST',{...input,email:'invalid'},randomUUID())).status,400);
      assert.equal((await req('/customers/page?pageSize=101',aToken)).status,400);
      assert.equal((await req('/customers/page')).status,401);
      assert.equal((await req('/orders',bToken,'POST',orderInput(c.id,b.id),randomUUID())).status,403);
    });
    await t.test('profile update keeps ID, order link and saved stop contacts; version conflict',async()=>{
      const writes=await Promise.all([req('/customers/'+c.id,aToken,'PATCH',edit(c,{name:name+' edited'}),randomUUID()),req('/customers/'+c.id,aToken,'PATCH',edit(c,{name:name+' race'}),randomUUID())]);
      assert.deepEqual(writes.map(r=>r.status).sort(),[200,409]);c=writes.find(r=>r.status===200).body;
      assert.equal(c.version,2);const loaded=await req('/orders/'+order.id,aToken);assert.equal(loaded.body.customerId,c.id);assert.equal(loaded.body.stops[0].contactName,'Sender snapshot');assert.equal(loaded.body.stops[0].address,'Original pickup');
      assert.equal((await req('/customers/'+c.id,aToken)).body.name,c.name);
    });
    await t.test('shared profile scope and order scope stay independent',async()=>{
      const shared=await req('/customers/'+c.id,admin,'PATCH',edit(c,{branchIds:[a.id,b.id]}),randomUUID());assert.equal(shared.status,200,JSON.stringify(shared.body));c=shared.body;
      const read=await req('/customers/'+c.id,bToken);assert.equal(read.status,200);assert.equal(read.body.canEdit,false);assert.equal(read.body.branches.length,1);assert.equal(read.body.orders.length,0);
      assert.equal((await req('/customers/'+c.id,aToken,'PATCH',edit(c),randomUUID())).status,403);
      const orderB=await req('/orders',bToken,'POST',orderInput(c.id,b.id),randomUUID());assert.equal(orderB.status,201,JSON.stringify(orderB.body));
      const pageA=await req('/customers/'+c.id+'/orders',aToken),pageB=await req('/customers/'+c.id+'/orders',bToken);
      assert.equal(pageA.body.total,1);assert.equal(pageB.body.total,1);assert.equal(pageA.body.items[0].id,order.id);assert.equal(pageB.body.items[0].id,orderB.body.id);
      assert.equal((await req('/orders/'+orderB.body.id,aToken)).status,404);
      assert.equal((await req('/customers/'+c.id,bToken,'PATCH',edit(c,{branchIds:[b.id]}),randomUUID())).status,403);
    });
    await t.test('unassigned legacy customer is admin-only until explicitly assigned',async()=>{
      const legacy=await db.customer.create({data:{code:'UNASSIGNED-'+randomUUID(),name:'[TEST] legacy no orders',phone:'same-phone'}});
      assert.equal((await req('/customers/'+legacy.id,aToken)).status,404);const read=await req('/customers/'+legacy.id,admin);assert.equal(read.status,200);
      const assigned=await req('/customers/'+legacy.id,admin,'PATCH',edit(read.body,{branchIds:[a.id]}),randomUUID());assert.equal(assigned.status,200);
      assert.equal((await req('/customers/'+legacy.id,aToken)).status,200);
    });
    await t.test('relation failure rolls back customer, command and audit atomically',async()=>{
      const failedName=name+' rollback';const key=randomUUID();
      await db.$executeRawUnsafe(`CREATE FUNCTION test_customer_relation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM customers WHERE id=NEW."customerId" AND name='${failedName}') THEN RAISE EXCEPTION 'injected test failure'; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe('CREATE TRIGGER test_customer_relation_failure BEFORE INSERT ON customer_branches FOR EACH ROW EXECUTE FUNCTION test_customer_relation_failure()');
      try{const r=await req('/customers',aToken,'POST',{...input,name:failedName},key);assert.equal(r.status,503);assert.equal(await db.customer.count({where:{name:failedName}}),0);assert.equal(await db.processedCommand.count({where:{idempotencyKey:key}}),0);}finally{await db.$executeRawUnsafe('DROP TRIGGER test_customer_relation_failure ON customer_branches');await db.$executeRawUnsafe('DROP FUNCTION test_customer_relation_failure()');}
    });
    await t.test('pagination, server search and legacy array contract',async()=>{
      const prefix='[PAGED '+randomUUID()+']';await db.customer.createMany({data:Array.from({length:30},(_,i)=>({id:randomUUID(),code:prefix+i,name:prefix+String(i).padStart(2,'0'),phone:'duplicate'}))});
      const added=await db.customer.findMany({where:{name:{startsWith:prefix}},select:{id:true}});await db.customerBranch.createMany({data:added.map(x=>({customerId:x.id,branchId:a.id}))});
      const p1=(await req('/customers/lookup?search='+encodeURIComponent(prefix)+'&page=1&pageSize=25',aToken)).body,p2=(await req('/customers/lookup?search='+encodeURIComponent(prefix)+'&page=2&pageSize=25',aToken)).body;
      assert.equal(p1.total,30);assert.equal(p1.items.length,25);assert.equal(p2.items.length,5);assert(!p1.items.some(x=>x.id===p2.items[0].id));
      assert.equal((await req('/customers/'+p2.items[0].id,aToken)).status,200);
      const legacy=await req('/customers',aToken);assert.equal(legacy.status,200);assert(Array.isArray(legacy.body));assert(legacy.body.some(x=>x.id===c.id));
      assert.equal(legacy.body.find(x=>x.id===c.id)._count.orders,1);
    });
    await t.test('customer visibility does not grant order read or profile write capability',async()=>{
      const role=await db.accessRole.findUniqueOrThrow({where:{code:'DISPATCHER'}});
      const permissions=await db.permission.findMany({where:{code:{in:['orders.read','customers.write']}}});
      await db.rolePermission.deleteMany({where:{roleId:role.id,permissionId:{in:permissions.map(p=>p.id)}}});
      try {
        const read=await req('/customers/'+c.id,aToken);assert.equal(read.status,200);assert.deepEqual(read.body.orders,[]);assert.equal(read.body.canEdit,false);
        assert.equal((await req('/customers/'+c.id+'/orders',aToken)).status,403);
        assert.equal((await req('/customers',aToken,'POST',input,randomUUID())).status,403);
        const legacy=await req('/customers',aToken);assert.equal(legacy.body.find(x=>x.id===c.id)._count.orders,0);
      } finally { await db.rolePermission.createMany({data:permissions.map(p=>({roleId:role.id,permissionId:p.id})),skipDuplicates:true}); }
    });
    await t.test('retail checkout keeps its identity, permits transport phone duplicates and preserves managed profile',async()=>{
      const { SalesOrdersService }=require('../dist/src/sales-orders/sales-orders.service');
      const { OutboxService }=require('../dist/src/common/services/outbox.service');
      const { InventoryService }=require('../dist/src/inventory/inventory.service');
      const { IdempotencyService }=require('../dist/src/common/services/idempotency.service');
      const { AuditLogService }=require('../dist/src/common/services/audit-log.service');
      const service=new SalesOrdersService(db,new OutboxService(db),new InventoryService(db,new IdempotencyService(db),new AuditLogService(db)));
      const actor=await db.user.findUniqueOrThrow({where:{username:'demo_auth_admin'}});
      const source=await db.location.create({data:{code:'CUSTOMER-TEST-'+randomUUID(),name:'[TEST] source',type:'STORE',managingBranchId:a.id,address:'Test',latitude:21,longitude:105}});
      const product=await db.product.create({data:{code:'CUSTOMER-TEST-'+randomUUID(),name:'[TEST] product'}});
      const sku=await db.sku.create({data:{productId:product.id,skuCode:'CUSTOMER-TEST-'+randomUUID(),name:'[TEST] sku',salePrice:100,lengthMm:10,widthMm:20,heightMm:30,weightGrams:100}});
      const phone='R-'+randomUUID();
      const transportResponse=await req('/customers',aToken,'POST',{...input,name:name+' transport duplicate',phone},randomUUID());assert.equal(transportResponse.status,201,JSON.stringify(transportResponse.body));const transport=transportResponse.body;
      const checkout=(customerName)=>service.checkoutOrder({customerName,customerPhone:phone,fulfillmentSourceId:source.id,deliveryAddress:'Test delivery',deliveryLatitude:21.1,deliveryLongitude:105.1,idempotencyKey:randomUUID(),items:[{skuId:sku.id,quantity:1}]},{id:actor.id,role:'ADMIN'});
      const first=await checkout('Retail first'),second=await checkout('Retail updated');assert.notEqual(first.customerId,transport.id);assert.equal(first.customerId,second.customerId);
      await db.customerBranch.create({data:{customerId:first.customerId,branchId:a.id}});
      const third=await checkout('Must not overwrite managed name');assert.equal(third.customerId,first.customerId);
      const profile=await db.customer.findUniqueOrThrow({where:{id:first.customerId}});assert.equal(profile.name,'Retail updated');assert.equal(profile.retailPhoneKey,phone);
      assert.equal((await service.findSalesOrderById(third.id,{id:actor.id,role:'ADMIN'})).id,third.id);
      assert.equal((await db.customer.findUniqueOrThrow({where:{id:transport.id}})).name,name+' transport duplicate');
    });
    await t.test('audit is committed with profile writes and does not copy contact data',async()=>{
      const logs=await db.auditLog.findMany({where:{entityType:'Customer',entityId:c.id}});assert.equal(logs.length,3);assert(logs.every(x=>x.actorUserId&&x.correlationId));assert(!JSON.stringify(logs).includes('client@example.test'));
    });
  } finally { await app.close(); }
});
