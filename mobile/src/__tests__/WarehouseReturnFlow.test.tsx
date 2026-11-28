import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { DriverApp } from "../DriverApp";
import { detail, harness, reply } from "./fixtures";

test("driver mobile supports pickup-confirm, delivery-confirm, busy failure category, and warehouse return", async () => {
  const h = harness("token-a");

  const multiStopDetail = {
    ...detail,
    status: "ACCEPTED" as const,
    trip: {
      ...detail.trip,
      status: "IN_PROGRESS" as const,
      version: 2,
      stops: [
        detail.trip.stops[0],
        detail.trip.stops[1],
        {
          id: "stop-hub-end",
          sequence: 3,
          stopType: "DEPOT_END",
          status: "PENDING",
          skipReason: null,
          hubLocationId: "wh-1",
          hubLocation: {
            id: "wh-1",
            code: "WH-DAD-01",
            name: "Kho Trung Chuyển Đà Nẵng",
            address: "123 Tôn Đức Thắng",
          },
          address: "Kho Trung Chuyển Đà Nẵng",
          latitude: 16.06,
          longitude: 108.15,
          contactName: null,
          contactPhone: null,
          plannedArrivalTime: null,
          plannedDepartureTime: null,
          tasks: [],
        },
      ],
    },
  };

  render(<DriverApp store={h.store} />);
  await screen.findByText("Chuyến của tôi");
  h.fetcher.mockResolvedValueOnce(reply(multiStopDetail));
  fireEvent.press(screen.getByRole("button", { name: "Xem TRIP-A" }));

  await screen.findByRole("button", { name: "Xác nhận đã lấy hàng" });
  h.fetcher
    .mockResolvedValueOnce(
      reply({
        taskId: "t1",
        packageId: "p1",
        packageStatus: "LOADED",
        tripId: "tr1",
        tripStatus: "IN_PROGRESS",
        tripVersion: 3,
        assignmentVersion: 1,
      }),
    )
    .mockResolvedValueOnce(reply(multiStopDetail));
  fireEvent.press(screen.getByRole("button", { name: "Xác nhận đã lấy hàng" }));
  await waitFor(() =>
    expect(h.fetcher.mock.calls.some((c) => String(c[0]).includes("/pickup-confirm"))).toBe(true),
  );

  fireEvent.press(
    await screen.findByRole("button", { name: "Khách bận / Không thể nhận hàng" }),
  );
  await screen.findByText(/Báo giao thất bại/);

  h.fetcher
    .mockResolvedValueOnce(
      reply({
        attemptId: "att-1",
        tripVersion: 4,
        failureCategory: "CUSTOMER_BUSY",
        continuation: {
          returnWarehouseId: "wh-1",
          returnWarehouseName: "Kho Trung Chuyển Đà Nẵng",
          keptDeliveryStopIds: [],
          returnToHubStopIds: [],
          detachedOrderIds: [],
          usedExactPlacements: true,
        },
      }),
    )
    .mockResolvedValueOnce(reply(multiStopDetail));

  fireEvent.press(
    screen.getByRole("button", { name: "Gửi báo cáo & Tính lộ trình về kho" }),
  );
  await waitFor(() =>
    expect(
      h.fetcher.mock.calls.some((c) => String(c[0]).includes("/delivery-failure")),
    ).toBe(true),
  );

  const returnBtn = await screen.findByRole("button", {
    name: "Xác nhận trả hàng về kho",
  });
  h.fetcher
    .mockResolvedValueOnce(
      reply({
        stopId: "stop-hub-end",
        warehouse: {
          id: "wh-1",
          code: "WH-DAD-01",
          name: "Kho Trung Chuyển Đà Nẵng",
          address: "123 Tôn Đức Thắng",
        },
        returnedPackageIds: ["p1"],
        returnedPackageCount: 1,
        tripId: "tr1",
        tripStatus: "COMPLETED",
        tripVersion: 5,
        tripCompleted: true,
      }),
    )
    .mockResolvedValueOnce(reply(multiStopDetail));
  fireEvent.press(returnBtn);
  await waitFor(() =>
    expect(
      h.fetcher.mock.calls.some((c) => String(c[0]).includes("/return-to-hub")),
    ).toBe(true),
  );
});
