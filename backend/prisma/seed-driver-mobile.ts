import * as dotenv from "dotenv";
import * as bcrypt from "bcryptjs";
import { Prisma, PrismaClient } from "@prisma/client";
import { requiredDemoPassword } from "./seed-auth";

// Explicit demo execution fixtures, not a bypass of the production publish API.
export async function createDriverDemoTrip(
  tx: Prisma.TransactionClient,
  tag: string,
  branchId: string,
  vehicleId: string,
  driverId: string,
) {
  const tripNumber = "DEMO-MOBILE-" + tag;
  const existing = await tx.trip.findUnique({ where: { tripNumber } });
  if (existing) {
    if (
      existing.notes !==
      "[DEMO MOBILE] Execution fixture; not a solver validation"
    )
      throw new Error("Demo trip collision");
    return existing;
  }
  const last = await tx.driverAssignment.findFirst({
    where: { OR: [{ driverId }, { trip: { vehicleId } }] },
    orderBy: { endTime: "desc" },
    select: { endTime: true },
  });
  const start = new Date(
    Math.max(
      Date.parse("2030-01-15T02:00:00Z"),
      (last?.endTime.getTime() ?? 0) + 3600000,
    ),
  );
  const end = new Date(start.getTime() + 4 * 3600000);
  const customer = await tx.customer.upsert({
    where: { code: tripNumber },
    update: {},
    create: {
      code: tripNumber,
      name: "[DEMO MOBILE] Customer",
      phone: tripNumber,
    },
  });
  const order = await tx.order.create({
    data: {
      orderNumber: tripNumber,
      customerId: customer.id,
      branchId,
      status: "ASSIGNED",
      packageDataStatus: "COMPLETE",
      totalPackages: 1,
      totalWeightKg: 10,
      totalVolumeM3: 0.008,
      items: {
        create: {
          description: "[DEMO] Kiện hàng thử",
          quantity: 1,
          weightKg: 10,
          lengthCm: 20,
          widthCm: 20,
          heightCm: 20,
          volumeM3: 0.008,
        },
      },
      stops: {
        create: (["PICKUP", "DELIVERY"] as const).map((type, i) => ({
          type,
          sequence: i + 1,
          address: "[DEMO] Điểm " + (i + 1),
          latitude: 21.03 + i * 0.01,
          longitude: 105.85,
          contactName: "Liên hệ demo",
          contactPhone: "0000000000",
          windowStart: start,
          windowEnd: end,
          windowBasis: "SERVICE_START",
        })),
      },
    },
    include: { items: true, stops: { orderBy: { sequence: "asc" } } },
  });
  const parcel = await tx.package.create({
    data: {
      orderId: order.id,
      orderItemId: order.items[0].id,
      packageCode: tripNumber,
      lengthMm: 200,
      widthMm: 200,
      heightMm: 200,
      weightG: 10000n,
      allowedOrientations: ["DEFAULT"],
      measurementSource: "DEMO",
      status: "ALLOCATED",
    },
  });
  const trip = await tx.trip.create({
    data: {
      tripNumber,
      managingBranchId: branchId,
      vehicleId,
      status: "DISPATCHED",
      version: 2,
      plannedStartTime: start,
      plannedEndTime: end,
      notes: "[DEMO MOBILE] Execution fixture; not a solver validation",
      assignments: { create: { driverId, startTime: start, endTime: end } },
    },
  });
  const allocation = await tx.allocation.create({
    data: {
      tripId: trip.id,
      orderItemId: order.items[0].id,
      packageId: parcel.id,
      allocatedQuantity: 1,
    },
  });
  for (const [i, stop] of order.stops.entries())
    await tx.tripStop.create({
      data: {
        tripId: trip.id,
        sequence: i + 1,
        stopType: stop.type,
        address: stop.address,
        latitude: stop.latitude,
        longitude: stop.longitude,
        contactName: stop.contactName,
        contactPhone: stop.contactPhone,
        plannedArrivalTime: i ? end : start,
        tasks: {
          create: {
            action: i ? "UNLOAD" : "LOAD",
            allocationId: allocation.id,
            orderStopId: stop.id,
            plannedQuantity: 1,
          },
        },
      },
    });
  return trip;
}

export async function seedDriverMobile(db: PrismaClient) {
  const password = await bcrypt.hash(requiredDemoPassword(), 12);
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(71007, 0)`;
      const role = await tx.accessRole.findUniqueOrThrow({
        where: { code: "DRIVER" },
      });
      const result: Array<{
        username: string;
        driverId: string;
        tripId: string;
      }> = [];
      for (const label of ["A", "B"]) {
        const code = "DEMO-MOBILE-" + label;
        const username = "demo_driver_" + label.toLowerCase();
        const branch = await tx.branch.upsert({
          where: { code },
          update: {},
          create: {
            code,
            name: "[DEMO MOBILE] " + label,
            address: "[DEMO] Chi nhánh " + label,
            latitude: 21.03,
            longitude: 105.85,
          },
        });
        const oldUser = await tx.user.findUnique({ where: { username } });
        if (oldUser && oldUser.fullName !== "[DEMO MOBILE] " + username)
          throw new Error("Demo username collision");
        const user = await tx.user.upsert({
          where: { username },
          update: {},
          create: {
            username,
            password,
            fullName: "[DEMO MOBILE] " + username,
            role: "DRIVER",
            branchId: branch.id,
          },
        });
        const driver = await tx.driver.upsert({
          where: { citizenId: code },
          update: {},
          create: {
            userId: user.id,
            citizenId: code,
            fullName: "[DEMO MOBILE] Tài xế " + label,
            phone: "0000000000",
            licenseNumber: code,
            licenseClass: "C",
            licenseExpiry: new Date("2035-01-01"),
            homeBranchId: branch.id,
          },
        });
        if (driver.userId !== user.id || driver.homeBranchId !== branch.id)
          throw new Error("Demo driver linkage differs; refusing overwrite");
        if (!oldUser)
          await tx.userRoleScope.create({
            data: {
              userId: user.id,
              roleId: role.id,
              scopeType: "BRANCH",
              branchId: branch.id,
            },
          });
        const vehicle = await tx.vehicle.upsert({
          where: { plateNumber: code },
          update: {},
          create: {
            plateNumber: code,
            model: "[DEMO MOBILE]",
            vehicleType: "Demo",
            homeBranchId: branch.id,
            payloadCapacityKg: 1000,
            volumeCapacityM3: 10,
            lengthCm: 400,
            widthCm: 200,
            heightCm: 200,
          },
        });
        const trip = await createDriverDemoTrip(
          tx,
          label,
          branch.id,
          vehicle.id,
          driver.id,
        );
        result.push({ username, driverId: driver.id, tripId: trip.id });
      }
      return result;
    },
    { timeout: 30000 },
  );
}
if (require.main === module) {
  dotenv.config();
  const db = new PrismaClient();
  seedDriverMobile(db)
    .then(console.log)
    .catch(() => {
      console.error(
        "Driver seed failed; check configuration/migration/demo collisions",
      );
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
