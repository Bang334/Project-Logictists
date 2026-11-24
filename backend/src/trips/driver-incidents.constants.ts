export const DRIVER_INCIDENT_TYPES = [
  "VEHICLE_BREAKDOWN",
  "ACCIDENT",
  "TRAFFIC_JAM",
  "ROAD_BLOCKED",
  "PACKAGE_DAMAGED",
  "PACKAGE_MISSING",
  "SECURITY_ISSUE",
  "OTHER",
] as const;

export type DriverIncidentType = (typeof DRIVER_INCIDENT_TYPES)[number];

export const DRIVER_INCIDENT_SEVERITIES = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;

export type DriverIncidentSeverity =
  (typeof DRIVER_INCIDENT_SEVERITIES)[number];

export const DRIVER_INCIDENT_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
] as const;

export const DRIVER_INCIDENT_COMMAND = "CREATE_DRIVER_INCIDENT";
export const DRIVER_INCIDENT_EVENT = "INCIDENT_REPORTED";

export const DRIVER_INCIDENT_STATUS_OPEN = "OPEN";
