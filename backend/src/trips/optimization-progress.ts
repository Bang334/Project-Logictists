export const OPTIMIZATION_PROGRESS_STAGES = [
  'QUEUED',
  'LOADING_INPUT',
  'BUILDING_MATRIX',
  'SEARCHING_SOLUTIONS',
  'BUILDING_ROUTE_GEOMETRY',
  'SAVING_RESULTS',
  'COMPLETED',
] as const;

export type OptimizationProgressStage =
  (typeof OPTIMIZATION_PROGRESS_STAGES)[number];

export type OptimizationProgressDetails = {
  orderCount?: number;
  packageCount?: number;
  physicalVehicleCount?: number;
  driverCount?: number;
  serviceSlotCount?: number;
  candidateCount?: number;
};

export type OptimizationProgressUpdate = {
  stage: OptimizationProgressStage;
  details?: OptimizationProgressDetails;
};

export type OptimizationProgressReporter = (
  update: OptimizationProgressUpdate,
) => Promise<void>;
