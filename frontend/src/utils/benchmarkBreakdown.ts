import {
  BenchmarkComparisonUI,
  BenchmarkMetricUI,
  CandidateCostBreakdownUI,
  FleetOptimizationResultUI,
  OptimizationCandidateSummaryUI,
  PlanningObjectiveBreakdownUI,
} from '../types';

export interface BenchmarkBreakdownPlanColumn {
  key: string;
  kind: 'candidate' | 'direct';
  candidateNumber?: number;
  rankLabel: string;
  title: string;
  isBest: boolean;
  isSelected: boolean;
  isCompleteFeasible: boolean;
  hasData: boolean;
  planningSpanDays: number;
  costBreakdown?: CandidateCostBreakdownUI;
  routeSubtotalVnd: number;
  idleSalaryVnd: number;
  operationalPenaltyVnd: number;
  effectiveCostVnd: number;
}

export interface BuildBenchmarkBreakdownParams {
  benchmarks: BenchmarkComparisonUI;
  planningObjective?: PlanningObjectiveBreakdownUI | null;
  candidates?: OptimizationCandidateSummaryUI[];
  candidateResults?: Record<number, FleetOptimizationResultUI>;
  selectedCandidateNumber?: number;
  displayedCandidateNumber?: number;
  showingDirect?: boolean;
}

function isFiniteNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function extractCostBreakdownFromMetric(
  metric: Partial<BenchmarkMetricUI> | null | undefined,
): CandidateCostBreakdownUI | undefined {
  if (!metric) return undefined;
  if (
    !isFiniteNum(metric.fuel_cost_vnd) ||
    !isFiniteNum(metric.vehicle_fixed_cost_vnd) ||
    !isFiniteNum(metric.driver_cost_vnd)
  ) {
    return undefined;
  }
  return {
    fuelCostVnd: metric.fuel_cost_vnd,
    vehicleFixedCostVnd: metric.vehicle_fixed_cost_vnd,
    driverCostVnd: metric.driver_cost_vnd,
    cargoHoldingCostVnd: isFiniteNum(metric.cargo_holding_cost_vnd)
      ? metric.cargo_holding_cost_vnd
      : 0,
    lateDeliveryPenaltyVnd: isFiniteNum(metric.late_delivery_penalty_vnd)
      ? metric.late_delivery_penalty_vnd
      : 0,
  };
}

export function resolveCandidateCostBreakdown(
  candidate: OptimizationCandidateSummaryUI,
  candidateResult?: FleetOptimizationResultUI | null,
  fallbackMetric?: BenchmarkMetricUI | null,
): CandidateCostBreakdownUI | undefined {
  if (candidate.costBreakdown) {
    return candidate.costBreakdown;
  }

  const fromResultBenchmark = extractCostBreakdownFromMetric(
    candidateResult?.benchmarks?.or_tools,
  );
  if (fromResultBenchmark) {
    return fromResultBenchmark;
  }

  if (candidateResult?.routes && candidateResult.routes.length > 0) {
    let fuelCostVnd = 0;
    let vehicleFixedCostVnd = 0;
    let driverCostVnd = 0;
    let cargoHoldingCostVnd = 0;
    let lateDeliveryPenaltyVnd = 0;
    let hasRouteCost = false;

    for (const route of candidateResult.routes) {
      if (!route.cost) continue;
      hasRouteCost = true;
      fuelCostVnd += Number(route.cost.fuel_cost_vnd ?? 0);
      vehicleFixedCostVnd += Number(route.cost.vehicle_fixed_cost_vnd ?? 0);
      driverCostVnd +=
        Number(route.cost.driver_fixed_salary_allocation_vnd ?? 0) +
        Number(route.cost.driver_trip_pay_vnd ?? 0);
      cargoHoldingCostVnd += Number(route.cost.cargo_holding_cost_vnd ?? 0);
      lateDeliveryPenaltyVnd += Number(route.cost.late_delivery_penalty_vnd ?? 0);
    }

    if (hasRouteCost) {
      return {
        fuelCostVnd,
        vehicleFixedCostVnd,
        driverCostVnd,
        cargoHoldingCostVnd,
        lateDeliveryPenaltyVnd,
      };
    }
  }

  return extractCostBreakdownFromMetric(fallbackMetric);
}

function isCandidateCompleteFeasible(candidate: OptimizationCandidateSummaryUI): boolean {
  return (
    (candidate.feasibilityStatus === 'SUCCESS' ||
      candidate.feasibilityStatus === 'FEASIBLE') &&
    candidate.unassignedOrderCount === 0
  );
}

export function buildBenchmarkBreakdownModel({
  benchmarks,
  planningObjective,
  candidates,
  candidateResults,
  selectedCandidateNumber,
  displayedCandidateNumber,
  showingDirect = false,
}: BuildBenchmarkBreakdownParams): {
  columns: BenchmarkBreakdownPlanColumn[];
  hasCompanyObjective: boolean;
  showOperationalPenaltyRow: boolean;
  bestColumnKey: string | null;
  bestEffectiveCostVnd: number | null;
} {
  const { or_tools, direct_dedicated } = benchmarks;
  const activeCandidateNumber =
    displayedCandidateNumber ??
    (selectedCandidateNumber && selectedCandidateNumber !== 0
      ? selectedCandidateNumber
      : 1);

  const orToolsSpanDays =
    planningObjective?.planning_span_days || or_tools.planning_span_days || 0;
  const activeHasCompanyObjective = Boolean(
    ((planningObjective && planningObjective.selection_score_vnd > 0) ||
      (or_tools.selection_score_vnd && or_tools.selection_score_vnd > 0)) &&
      orToolsSpanDays > 0,
  );

  const directSpanDays = direct_dedicated.planning_span_days || 0;
  const directHasCompanyObjective = Boolean(
    direct_dedicated.is_feasible &&
      direct_dedicated.selection_score_vnd &&
      direct_dedicated.selection_score_vnd > 0 &&
      directSpanDays > 0,
  );

  const candidateColumns: BenchmarkBreakdownPlanColumn[] =
    candidates && candidates.length > 0
      ? candidates.map((candidate) => {
          const isDisplayedActive =
            candidate.candidateNumber === activeCandidateNumber;
          const candidateResult = candidateResults?.[candidate.candidateNumber];
          const resultObjective = candidateResult?.planning_objective;
          const effectivePlanningObjective =
            resultObjective && resultObjective.selection_score_vnd > 0
              ? resultObjective
              : isDisplayedActive
                ? planningObjective
                : undefined;

          const spanDays =
            effectivePlanningObjective?.planning_span_days ||
            candidate.planningSpanDays ||
            candidateResult?.benchmarks?.or_tools?.planning_span_days ||
            (isDisplayedActive ? or_tools.planning_span_days ?? 0 : 0);

          const candidateScore =
            effectivePlanningObjective?.selection_score_vnd ||
            candidate.solverObjective ||
            candidateResult?.benchmarks?.or_tools?.selection_score_vnd ||
            (isDisplayedActive ? or_tools.selection_score_vnd ?? 0 : 0);

          const candidateHasCompanyObjective = Boolean(
            spanDays > 0 && candidateScore > 0,
          );

          const routeSubtotalVnd =
            candidate.totalCostVnd ||
            candidateResult?.total_cost_vnd ||
            (isDisplayedActive ? or_tools.total_cost_vnd : 0);

          const idleSalaryVnd = candidateHasCompanyObjective
            ? (effectivePlanningObjective?.driver_idle_salary_allocation_vnd ??
              candidate.driverIdleSalaryAllocationVnd ??
              candidateResult?.benchmarks?.or_tools?.driver_idle_salary_allocation_vnd ??
              (isDisplayedActive ? or_tools.driver_idle_salary_allocation_vnd ?? 0 : 0))
            : 0;

          const operationalPenaltyVnd = candidateHasCompanyObjective
            ? (effectivePlanningObjective?.operational_late_penalty_vnd ??
              candidate.operationalLatePenaltyVnd ??
              0)
            : 0;

          const effectiveCostVnd = candidateHasCompanyObjective
            ? candidateScore
            : routeSubtotalVnd;

          const costBreakdown = resolveCandidateCostBreakdown(
            candidate,
            candidateResult,
            isDisplayedActive ? or_tools : undefined,
          );
          const isCompleteFeasible = isCandidateCompleteFeasible(candidate);
          const hasData = Boolean(
            costBreakdown || routeSubtotalVnd > 0 || isCompleteFeasible,
          );

          return {
            key: `candidate-${candidate.candidateNumber}`,
            kind: 'candidate',
            candidateNumber: candidate.candidateNumber,
            rankLabel:
              candidate.candidateNumber === 1
                ? '#1 tốt nhất'
                : `#${candidate.candidateNumber}`,
            title:
              candidate.searchStrategy?.trim() ||
              `Phương án #${candidate.candidateNumber}`,
            isBest: false,
            isSelected: !showingDirect && isDisplayedActive,
            isCompleteFeasible,
            hasData,
            planningSpanDays: spanDays,
            costBreakdown,
            routeSubtotalVnd,
            idleSalaryVnd,
            operationalPenaltyVnd,
            effectiveCostVnd,
          };
        })
      : [
          {
            key: 'or_tools',
            kind: 'candidate',
            candidateNumber: 1,
            rankLabel: 'Phương án tối ưu',
            title: 'Hybrid ALNS (Tối ưu)',
            isBest: false,
            isSelected: !showingDirect,
            isCompleteFeasible: or_tools.is_feasible,
            hasData: true,
            planningSpanDays: orToolsSpanDays,
            costBreakdown: extractCostBreakdownFromMetric(or_tools),
            routeSubtotalVnd: or_tools.total_cost_vnd,
            idleSalaryVnd: activeHasCompanyObjective
              ? (planningObjective?.driver_idle_salary_allocation_vnd ??
                or_tools.driver_idle_salary_allocation_vnd ??
                0)
              : 0,
            operationalPenaltyVnd: activeHasCompanyObjective
              ? (planningObjective?.operational_late_penalty_vnd ?? 0)
              : 0,
            effectiveCostVnd: activeHasCompanyObjective
              ? (planningObjective?.selection_score_vnd ||
                or_tools.selection_score_vnd ||
                or_tools.total_cost_vnd)
              : or_tools.total_cost_vnd,
          },
        ];

  const anyCandidateHasCompanyObjective = candidateColumns.some(
    (col) => col.planningSpanDays > 0 && col.effectiveCostVnd > 0 && (col.idleSalaryVnd > 0 || col.operationalPenaltyVnd > 0 || col.effectiveCostVnd !== col.routeSubtotalVnd || activeHasCompanyObjective),
  );
  const hasCompanyObjective =
    activeHasCompanyObjective || anyCandidateHasCompanyObjective;

  const directEffectiveCostVnd =
    hasCompanyObjective && directHasCompanyObjective
      ? direct_dedicated.selection_score_vnd!
      : direct_dedicated.total_cost_vnd;

  const directColumn: BenchmarkBreakdownPlanColumn = {
    key: 'direct',
    kind: 'direct',
    rankLabel: 'Đối chuẩn',
    title: 'Chuyến đơn lẻ (Direct Dedicated)',
    isBest: false,
    isSelected: showingDirect,
    isCompleteFeasible: direct_dedicated.is_feasible,
    hasData: direct_dedicated.is_feasible,
    planningSpanDays: directSpanDays,
    costBreakdown: direct_dedicated.is_feasible
      ? extractCostBreakdownFromMetric(direct_dedicated)
      : undefined,
    routeSubtotalVnd: direct_dedicated.total_cost_vnd,
    idleSalaryVnd:
      hasCompanyObjective && directHasCompanyObjective
        ? (direct_dedicated.driver_idle_salary_allocation_vnd ?? 0)
        : 0,
    operationalPenaltyVnd:
      hasCompanyObjective && directHasCompanyObjective
        ? (direct_dedicated.operational_late_penalty_vnd ?? 0)
        : 0,
    effectiveCostVnd: directEffectiveCostVnd,
  };

  const columns = [...candidateColumns, directColumn];
  const feasibleColumns = columns.filter((col) => col.isCompleteFeasible);
  const bestColumn = feasibleColumns.reduce<BenchmarkBreakdownPlanColumn | null>(
    (best, col) =>
      !best || col.effectiveCostVnd < best.effectiveCostVnd ? col : best,
    null,
  );
  const bestColumnKey = bestColumn?.key ?? null;
  const bestEffectiveCostVnd = bestColumn?.effectiveCostVnd ?? null;

  for (const col of columns) {
    col.isBest = col.key === bestColumnKey;
  }

  const showOperationalPenaltyRow = columns.some(
    (col) => col.hasData && col.operationalPenaltyVnd > 0,
  );

  return {
    columns,
    hasCompanyObjective,
    showOperationalPenaltyRow,
    bestColumnKey,
    bestEffectiveCostVnd,
  };
}
