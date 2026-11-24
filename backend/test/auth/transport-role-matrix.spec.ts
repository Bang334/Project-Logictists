import "reflect-metadata";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ROLES_KEY } from "../../src/auth/roles.decorator";
import { BranchesController } from "../../src/branches/branches.controller";
import { CustomersController } from "../../src/customers/customers.controller";
import { DriversController } from "../../src/drivers/drivers.controller";
import { OrdersController } from "../../src/orders/orders.controller";
import { UpdateOrderDto } from "../../src/orders/dto/update-order.dto";
import { TripsController } from "../../src/trips/trips.controller";
import { VehiclesController } from "../../src/vehicles/vehicles.controller";

const OPERATION_ROLES = [Role.ADMIN, Role.DISPATCHER];

describe("M2.0 transport role matrix", () => {
  it.each([
    ["orders", OrdersController],
    ["customers", CustomersController],
    ["trips", TripsController],
    ["branches", BranchesController],
    ["vehicles", VehiclesController],
    ["drivers", DriversController],
  ])("%s chỉ cho ADMIN/DISPATCHER ở cấp controller", (_name, controller) => {
    expect(Reflect.getMetadata(ROLES_KEY, controller)).toEqual(OPERATION_ROLES);
  });

  it("generic load plan chỉ cho ADMIN/DISPATCHER", () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, TripsController.prototype.getLoadPlan),
    ).toEqual([Role.ADMIN, Role.DISPATCHER]);
  });

  it("generic PATCH Order từ chối field status", async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });

    await expect(
      pipe.transform(
        { status: "CONFIRMED", notes: "Không được đổi trạng thái tại đây" },
        { type: "body", metatype: UpdateOrderDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
