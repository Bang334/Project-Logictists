/* Import the preserved Da Nang stress fixture into the local branch. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const prefix = 'STRESS-DAD-20261118';
const source = path.resolve(__dirname, '../../optimizer/benchmarks/stress_3d_road_multiday_20261118/input.json');
const payload = JSON.parse(fs.readFileSync(source, 'utf8'));
const digest = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');

async function main() {
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(181126120)");
    const branch = await tx.branch.findUniqueOrThrow({ where: { code: 'BRANCH-DAD' } });
    const existing = await tx.order.findMany({
      where: { orderNumber: { startsWith: prefix } },
      select: { id: true, notes: true },
    });
    if (existing.length) {
      if (existing.length !== 120 || existing.some(order => !order.notes?.includes(digest))) {
        throw new Error('Existing stress import differs from the fixture. No changes applied.');
      }
      return { branchCode: branch.code, alreadyImported: true, orders: existing.length };
    }
    const customer = await tx.customer.create({
      data: { code: prefix, name: 'Khách thử nghiệm 3D Đà Nẵng', phone: prefix },
    });
    const depot = await tx.location.create({
      data: {
        code: prefix + '-DEPOT', name: 'Bãi thử nghiệm 3D Đà Nẵng',
        type: 'CENTRAL_WAREHOUSE', managingBranchId: branch.id,
        address: payload.vehicles[0].depot.name,
        latitude: payload.vehicles[0].depot.latitude,
        longitude: payload.vehicles[0].depot.longitude,
        timezone: branch.timezone,
      },
    });
    const vehicles = payload.vehicles.filter(vehicle => vehicle.service_day_index === 0);
    for (const [index, vehicle] of vehicles.entries()) {
      const type = await tx.vehicleType.create({
        data: {
          code: prefix + '-TYPE-' + index, name: 'Xe thử nghiệm 3D ' + (index + 1),
          lengthCm: vehicle.length_cm, widthCm: vehicle.width_cm, heightCm: vehicle.height_cm,
          payloadCapacityKg: vehicle.payload_limit_kg,
          volumeCapacityM3: vehicle.length_cm * vehicle.width_cm * vehicle.height_cm / 1e6,
          fuelConsumptionLitersPer100Km: vehicle.fuel_consumption_liters_per_100_km,
          fixedOperatingCostPerTrip: vehicle.fixed_operating_cost_vnd,
          requiredLicenseCategory: 'C',
        },
      });
      await tx.vehicle.create({
        data: {
          plateNumber: prefix + '-V-' + (index + 1), model: 'STRESS 3D',
          homeBranchId: branch.id, vehicleTypeId: type.id,
          homeDepotLocationId: depot.id,
          currentLatitude: depot.latitude, currentLongitude: depot.longitude,
          lastLocationAt: new Date(),
        },
      });
    }
    for (const [index, driver] of payload.drivers.filter(driver => driver.service_day_index === 0).entries()) {
      await tx.driver.create({
        data: {
          fullName: 'Tài xế thử nghiệm 3D ' + (index + 1),
          citizenId: prefix + '-CIT-' + index, phone: prefix + '-PHONE-' + index,
          licenseNumber: prefix + '-LICENSE-' + index,
          licenseClass: driver.license_class, licenseExpiry: new Date('2035-12-31'),
          homeBranchId: branch.id,
          fixedSalaryMonthly: driver.fixed_salary_monthly_vnd,
          tripBasePay: driver.trip_base_pay_vnd, perKmPay: driver.per_km_pay_vnd,
        },
      });
    }
    const orderedAt = new Date();
    for (const [index, order] of payload.orders.entries()) {
      const weight = order.items.reduce((sum, item) => sum + item.weight_kg, 0);
      const volume = order.items.reduce((sum, item) => sum + item.length_cm * item.width_cm * item.height_cm / 1e6, 0);
      await tx.order.create({
        data: {
          orderNumber: prefix + '-O-' + String(index + 1).padStart(3, '0'),
          customerId: customer.id, branchId: branch.id, status: 'CONFIRMED',
          packageDataStatus: 'COMPLETE', orderedAt,
          totalPackages: order.items.length, totalWeightKg: weight, totalVolumeM3: volume,
          notes: 'Synthetic stress fixture sha256=' + digest,
          stops: { create: ['pickup_location', 'delivery_location'].map((key, stopIndex) => ({
            type: stopIndex === 0 ? 'PICKUP' : 'DELIVERY', sequence: stopIndex + 1,
            address: order[key].name, latitude: order[key].latitude, longitude: order[key].longitude,
            contactName: 'Liên hệ thử nghiệm', contactPhone: prefix,
            serviceDurationMinutes: order.service_time_sec / 60,
          })) },
          items: { create: [{
            description: 'Kiện thử nghiệm 3D ' + (index + 1), quantity: order.items.length,
            weightKg: weight, volumeM3: volume,
            packages: { create: order.items.map((item, itemIndex) => ({
              packageCode: prefix + '-P-' + index + '-' + itemIndex,
              lengthMm: item.length_cm * 10, widthMm: item.width_cm * 10, heightMm: item.height_cm * 10,
              weightG: BigInt(Math.round(item.weight_kg * 1000)),
              cargoKind: item.cargo_kind, allowUpperTier: item.allow_upper_tier,
              maxTopLoadG: item.max_top_load_g, measurementSource: 'USER_DECLARED', status: 'READY',
            })) },
          }] },
        },
      });
    }
    await tx.systemSetting.upsert({
      where: { branchId: branch.id },
      create: { scopeType: 'BRANCH', branchId: branch.id, overrideStacking: true,
        stackingEnabled: true, stackingOwnerMode: 'SAME_CUSTOMER', stackingMaxTiers: 3, stackingLiftClearanceMm: 50 },
      update: { overrideStacking: true, stackingEnabled: true, stackingOwnerMode: 'SAME_CUSTOMER',
        stackingMaxTiers: 3, stackingLiftClearanceMm: 50, version: { increment: 1 } },
    });
    return { branchCode: branch.code, alreadyImported: false, orders: 120, packages: 1260, vehicles: 20, drivers: 20 };
  }, { timeout: 120000 });
  console.log(JSON.stringify(result));
}

main().catch(error => {
  console.error(error.code || error.message);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
