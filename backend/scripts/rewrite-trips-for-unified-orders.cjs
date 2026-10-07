const fs = require('fs');
const file = 'src/trips/trips.service.ts';
let source = fs.readFileSync(file, 'utf8');

source = source.replace(
  /        for \(const orderItem of item\.order\.items\) \{[\s\S]*?(?=\n      \/\/[^\n]*\n      await tx\.driverAssignment)/,
  `        await tx.stopTask.create({
          data: {
            tripStopId: tripStop.id,
            orderId: item.order.id,
            orderStopId: item.orderStop.id,
            action: isPickup ? TaskAction.LOAD : TaskAction.UNLOAD,
            plannedQuantity: item.order.items.reduce((sum, orderItem) => sum + orderItem.quantity, 0),
          },
        });
      }
`,
);

source = source.replace(
  /  async getLoadProfile\(id: string\) \{[\s\S]*?(?=  async runOptimization)/,
  `  async getLoadProfile(id: string) {
    const trip = await this.findOne(id);
    const stopsWithItems: StopWithItems[] = [];
    for (const stop of trip.stops) {
      for (const task of stop.tasks) {
        if (!task.order) continue;
        stopsWithItems.push({
          orderStop: { orderId: task.order.id, type: stop.stopType, address: stop.address },
          order: { id: task.order.id, orderNumber: task.order.orderNumber, totalWeightKg: task.order.totalWeightKg, totalVolumeM3: task.order.totalVolumeM3, items: task.order.items },
        });
      }
    }
    return TripsValidator.calculateAndValidateLoad(trip.vehicle, stopsWithItems);
  }

  `,
);

source = source.replace(
  /  private async assertOrdersNotOnActiveTrip\([\s\S]*?(?=  private async assertNoResourceOverlap)/,
  `  private async assertOrdersNotOnActiveTrip(tx: Prisma.TransactionClient, orderIds: string[]): Promise<void> {
    const conflicting = await tx.stopTask.findFirst({
      where: { orderId: { in: orderIds }, tripStop: { trip: { status: { in: ACTIVE_TRIP_STATUSES } } } },
      include: { tripStop: { include: { trip: true } }, order: true },
    });
    if (conflicting) throw new ConflictException(\`Đơn \${conflicting.order?.orderNumber} đã nằm trên chuyến \${conflicting.tripStop.trip.tripNumber}\`);
  }

  `,
);

source = source.replace(/\n    const allocationIdByItemId = new Map<string, string>\(\);[\s\S]*?\n    const orderById/, '\n    const orderById');
source = source.replace(
  /      for \(const item of order\.items\) \{[\s\S]*?(?=\n    \}\n\n    await tx\.driverAssignment)/,
  `      await tx.stopTask.create({
        data: {
          tripStopId: tripStop.id,
          orderId: order.id,
          orderStopId: stop.orderStopId,
          action: stop.stopType === StopType.PICKUP ? TaskAction.LOAD : TaskAction.UNLOAD,
          plannedQuantity: order.items.reduce((sum, item) => sum + item.quantity, 0),
        },
      });`,
);

fs.writeFileSync(file, source);
