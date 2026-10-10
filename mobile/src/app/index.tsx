import React from "react";
import { DriverApp } from "../DriverApp";
import { useDriverStore } from "../DriverContext";
export default function LoginRoute() {
  return <DriverApp store={useDriverStore()} manageSession={false} />;
}
