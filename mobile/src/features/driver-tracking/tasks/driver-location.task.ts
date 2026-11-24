import { driverTrackingService } from '@/features/driver-tracking/services/driver-tracking.service';
import { driverGpsStorage } from '@/features/driver-tracking/storage/driver-gps.storage';
import { DRIVER_LOCATION_TASK, isDriverLocationTask } from './driver-location.registration';

// Expo dispatches a pending event after loading the entry module. Bind the
// persisted task synchronously so a headless launch can resolve its executor.
for (const taskName of driverGpsStorage.readTaskNamesAtStartup()) {
  if (taskName !== DRIVER_LOCATION_TASK && isDriverLocationTask(taskName)) {
    driverTrackingService.defineLocationTask(taskName);
  }
}
