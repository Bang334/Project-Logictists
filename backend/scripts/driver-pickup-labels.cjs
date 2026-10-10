// Read only, isolated demo DB only; no customer/credential data in labels.
const fs = require('node:fs/promises');
const path = require('node:path');
const QRCode = require('qrcode');
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
(async () => {
  const url = new URL(process.env.DATABASE_URL);
  if (!['localhost','127.0.0.1'].includes(url.hostname) || url.pathname !== '/tms_driver_test_20261007') throw new Error('Isolated driver demo DB required');
  const trips = await db.trip.findMany({
    where: { tripNumber: { in: ['DEMO-MOBILE-PICKUP-A','DEMO-MOBILE-PICKUP-B'] }, notes: '[DEMO MOBILE] Execution fixture; not a solver validation' },
    select: {
      tripNumber: true,
      allocations: { select: {
        package: { select: { id: true, packageCode: true } },
        orderItem: { select: { order: { select: { orderNumber: true } } } },
      } },
    },
  });
  if (trips.length !== 2) throw new Error('Run driver:pickup:seed first');
  const labels = [];
  for (const trip of trips) for (const allocation of trip.allocations) {
    const parcel = allocation.package;
    if (!parcel) throw new Error('Demo package missing');
    const svg = await QRCode.toString(`TMS:PACKAGE:1:${parcel.id}`, { type:'svg', errorCorrectionLevel:'M', margin:4 });
    labels.push(`<article><h2>${escape(trip.tripNumber)}</h2><p>DEMO — Lô: ${escape(allocation.orderItem.order.orderNumber)}</p>${svg}<p>Kiện: ${escape(parcel.packageCode)}</p></article>`);
  }
  const output = path.resolve('logs/driver-pickup-labels.html');
  await fs.mkdir(path.dirname(output), { recursive:true });
  await fs.writeFile(output, `<!doctype html><html lang="vi"><meta charset="utf-8"><title>QR kiện demo TMS</title><style>body{font:16px sans-serif;display:flex;flex-wrap:wrap;gap:24px}article{border:1px solid;padding:20px;width:350px;break-inside:avoid}svg{width:280px;height:280px}h2{font-size:18px}p{overflow-wrap:anywhere}</style>${labels.join('')}</html>`);
  console.log('Demo QR labels: ' + output);
})().catch(error => { console.error(error.message); process.exitCode=1; }).finally(()=>db.$disconnect());
