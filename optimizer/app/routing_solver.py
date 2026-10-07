import itertools
import time
from dataclasses import dataclass
from typing import Dict, List, Set, Tuple, Optional

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from .models import (
    CostPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    FleetVehicle,
    OptimizationRequest,
    OptimizationResponse,
    OptimizedRoute,
    OrderPair,
    ScheduledStop,
    SpatialValidationResult,
    StopAction,
    UnassignedOrder,
    can_driver_drive_vehicle,
)
from .spatial_validator import SpatialValidator
from .baseline_calculator import BaselineCostCalculator
from .ils_engine import PackingAwareILSOptimizer
from .route_costing import (
    build_route_cost_breakdown,
    calculate_driver_cost,
    calculate_route_economic_metrics,
    late_delivery_daily_penalty,
)
from .route_draft import RouteDraft
from .search_policy import SearchProgressTracker
from .search_strategies import DEFAULT_SEARCH_STRATEGY, SearchStrategy


# OR-Tools routing costs are integers. Micro-VND preserves small marginal
# costs such as the fuel surcharge of carrying one kilogram for one metre.
OBJECTIVE_COST_SCALE = 1_000_000
WEIGHT_SCALE = 100
ROUTING_BUDGET_SHARE = 0.65
VALIDATION_BUDGET_SHARE = 0.20
CONSOLIDATION_BUDGET_SHARE = 0.15


@dataclass
class ExhaustiveSearchResult:
    plans: List[FleetOptimizationResponse]
    completed: bool
    routing_enumeration_completed: bool
    spatial_validation_completed: bool
    assignment_enumeration_completed: bool
    route_sequences_evaluated: int
    complete_assignments_evaluated: int


class FleetRoutingSolver:
    """Multi-vehicle pickup/delivery routing over a provider-supplied road matrix."""

    def __init__(
        self,
        request: FleetOptimizationRequest,
        search_strategy: SearchStrategy = DEFAULT_SEARCH_STRATEGY,
        time_budget_seconds: Optional[float] = None,
        stagnation_seconds: Optional[float] = None,
        routing_budget_share: float = ROUTING_BUDGET_SHARE,
        validation_budget_share: float = VALIDATION_BUDGET_SHARE,
        consolidation_budget_share: float = CONSOLIDATION_BUDGET_SHARE,
    ):
        self.request = request
        self.search_strategy = search_strategy
        self.uses_adaptive_total_budget = time_budget_seconds is not None
        self.time_budget_seconds = float(
            time_budget_seconds
            if time_budget_seconds is not None
            else request.max_time_seconds
        )
        if self.time_budget_seconds <= 0:
            raise ValueError("time_budget_seconds must be greater than zero")
        self.stagnation_seconds = stagnation_seconds
        phase_shares = (
            routing_budget_share,
            validation_budget_share,
            consolidation_budget_share,
        )
        if any(share <= 0 for share in phase_shares):
            raise ValueError("search phase budget shares must be greater than zero")
        if abs(sum(phase_shares) - 1.0) > 1e-9:
            raise ValueError("search phase budget shares must sum to one")
        self.routing_budget_share = float(routing_budget_share)
        self.validation_budget_share = float(validation_budget_share)
        self.consolidation_budget_share = float(consolidation_budget_share)
        self.vehicle_count = len(request.vehicles)
        self.nodes = self._build_nodes()
        self.order_by_id = {order.id: order for order in request.orders}
        self.driver_safe_vehicle_indices = self._find_driver_safe_vehicle_indices()

    def _find_driver_safe_vehicle_indices(self) -> Set[int]:
        """Return a maximum vehicle subset with a one-to-one legal driver match."""
        driver_to_vehicle: Dict[int, int] = {}

        def assign(vehicle_index: int, seen_drivers: Set[int]) -> bool:
            vehicle = self.request.vehicles[vehicle_index]
            vehicle_type = vehicle.vehicle_type or vehicle.model or ""
            for driver_index, driver in enumerate(self.request.drivers):
                if driver_index in seen_drivers or not can_driver_drive_vehicle(
                    driver.license_class,
                    vehicle.payload_limit_kg,
                    vehicle_type,
                ):
                    continue
                if driver.service_day_index != vehicle.service_day_index:
                    continue
                seen_drivers.add(driver_index)
                previous_vehicle = driver_to_vehicle.get(driver_index)
                if previous_vehicle is None or assign(previous_vehicle, seen_drivers):
                    driver_to_vehicle[driver_index] = vehicle_index
                    return True
            return False

        for vehicle_index in range(len(self.request.vehicles)):
            assign(vehicle_index, set())
        return set(driver_to_vehicle.values())

    @staticmethod
    def _source_order_id(order: OrderPair) -> str:
        return order.source_order_id or order.id

    @staticmethod
    def _stop_allocation_id(stop: ScheduledStop) -> Optional[str]:
        return stop.allocation_id or stop.order_id

    @staticmethod
    def _order_allows_vehicle(order: OrderPair, vehicle: FleetVehicle) -> bool:
        if not order.allowed_source_vehicle_ids:
            return True
        return (vehicle.source_vehicle_id or vehicle.id) in set(
            order.allowed_source_vehicle_ids
        )

    def _unassigned_all(
        self, reason_code: str, reason_message: str
    ) -> List[UnassignedOrder]:
        rows: List[UnassignedOrder] = []
        seen: Set[str] = set()
        for order in self.request.orders:
            source_id = self._source_order_id(order)
            if source_id in seen:
                continue
            seen.add(source_id)
            rows.append(
                UnassignedOrder(
                    order_id=source_id,
                    order_number=order.source_order_number or order.order_number,
                    reason_code=reason_code,
                    reason_message=reason_message,
                )
            )
        return rows

    def _build_nodes(self) -> List[dict]:
        nodes: List[dict] = []
        for vehicle in self.request.vehicles:
            nodes.append(
                {
                    "id": vehicle.depot.id,
                    "name": vehicle.depot.name,
                    "lat": vehicle.depot.latitude,
                    "lon": vehicle.depot.longitude,
                    "type": "DEPOT",
                    "order": None,
                    "service_time_sec": 0,
                }
            )
        for order in self.request.orders:
            nodes.extend(
                [
                    {
                        "id": order.pickup_location.id,
                        "name": order.pickup_location.name,
                        "lat": order.pickup_location.latitude,
                        "lon": order.pickup_location.longitude,
                        "type": "PICKUP",
                        "order": order,
                        "service_time_sec": order.service_time_sec,
                    },
                    {
                        "id": order.delivery_location.id,
                        "name": order.delivery_location.name,
                        "lat": order.delivery_location.latitude,
                        "lon": order.delivery_location.longitude,
                        "type": "DELIVERY",
                        "order": order,
                        "service_time_sec": order.service_time_sec,
                    },
                ]
            )
        return nodes

    def solve(self) -> FleetOptimizationResponse:
        return self.solve_with_objective()[0]

    def solve_exhaustive_tiny_candidates(
        self,
        max_candidates: int = 3,
    ) -> ExhaustiveSearchResult:
        """Enumerate all precedence-valid routes for a tiny fleet request.

        The enumeration covers every non-empty order subset on every usable
        vehicle/day slot, validates dynamic loading geometry, then enumerates
        exact-cover assignments of those routes.  A shared wall-clock deadline
        keeps the normal adaptive budget as a hard bound.  ``completed`` is
        false when either that deadline or the spatial validator's own search
        bound is reached, so callers never confuse best-found with proven-best.
        """
        started_at = time.monotonic()
        deadline = started_at + self.time_budget_seconds
        node_id_to_idx = {node["id"]: index for index, node in enumerate(self.nodes)}
        all_order_ids = frozenset(order.id for order in self.request.orders)
        route_options: List[Tuple[int, frozenset, OptimizedRoute]] = []
        spatial_cache: Dict[Tuple, SpatialValidationResult] = {}
        route_sequences_evaluated = 0
        routing_enumeration_completed = True
        spatial_validation_completed = True

        # Larger subsets first: a fully served one-route plan is available as
        # early as possible even if the shared budget expires later.
        for subset_size in range(len(self.request.orders), 0, -1):
            for order_subset in itertools.combinations(self.request.orders, subset_size):
                for vehicle_index, vehicle in enumerate(self.request.vehicles):
                    if time.monotonic() >= deadline:
                        routing_enumeration_completed = False
                        break
                    if vehicle_index not in self.driver_safe_vehicle_indices:
                        continue
                    if not all(
                        self._order_allows_vehicle(order, vehicle)
                        for order in order_subset
                    ):
                        continue
                    if not all(
                        self._order_physically_fits_vehicle(order, vehicle)
                        for order in order_subset
                    ):
                        continue

                    sequences = self._generate_lifo_sequences(
                        list(order_subset),
                        deadline,
                    )
                    for sequence in sequences:
                        if time.monotonic() >= deadline:
                            routing_enumeration_completed = False
                            break
                        route_sequences_evaluated += 1
                        actions = self._actions_from_precedence_sequence(sequence)
                        evaluated = self._evaluate_resequence_candidate(
                            vehicle,
                            vehicle_index,
                            actions,
                            node_id_to_idx,
                        )
                        if evaluated is None:
                            continue

                        spatial_key = (
                            vehicle.length_cm,
                            vehicle.width_cm,
                            vehicle.height_cm,
                            vehicle.payload_limit_kg,
                            vehicle.door_position,
                            vehicle.door_width_cm,
                            tuple((action.stop_type, action.stop_id) for action in actions),
                        )
                        spatial = spatial_cache.get(spatial_key)
                        if spatial is None:
                            remaining_seconds = deadline - time.monotonic()
                            if remaining_seconds <= 0:
                                routing_enumeration_completed = False
                                break
                            spatial = SpatialValidator(
                                vehicle,
                                max_time_seconds=min(1.5, remaining_seconds),
                                max_search_nodes=5000,
                            ).validate_plan(actions)
                            spatial_cache[spatial_key] = spatial
                        if spatial.violation_code == "PLACEMENT_SEARCH_LIMIT_REACHED":
                            spatial_validation_completed = False
                        if not spatial.is_valid:
                            continue

                        scheduled, distance_meters, _, route_end_seconds = evaluated
                        route_options.append(
                            (
                                vehicle_index,
                                frozenset(order.id for order in order_subset),
                                self._build_candidate_route(
                                    vehicle,
                                    scheduled,
                                    distance_meters,
                                    route_end_seconds,
                                    spatial.model_copy(deep=True),
                                ),
                            )
                        )
                    if not routing_enumeration_completed and time.monotonic() >= deadline:
                        break
                if not routing_enumeration_completed and time.monotonic() >= deadline:
                    break
            if not routing_enumeration_completed and time.monotonic() >= deadline:
                break

        options_by_order: Dict[str, List[Tuple[int, frozenset, OptimizedRoute]]] = {
            order_id: [] for order_id in all_order_ids
        }
        for option in route_options:
            for order_id in option[1]:
                options_by_order[order_id].append(option)

        distinct_assignments: Dict[Tuple, List[OptimizedRoute]] = {}
        complete_assignment_count = 0
        assignment_enumeration_completed = True

        def enumerate_assignments(
            covered_order_ids: frozenset,
            used_vehicle_indices: frozenset,
            selected_routes: List[OptimizedRoute],
        ) -> None:
            nonlocal assignment_enumeration_completed, complete_assignment_count
            if time.monotonic() >= deadline:
                assignment_enumeration_completed = False
                return
            if covered_order_ids == all_order_ids:
                routes = [route.model_copy(deep=True) for route in selected_routes]
                try:
                    self._assign_drivers_and_costs(routes)
                except ValueError:
                    return
                complete_assignment_count += 1
                signature = tuple(
                    sorted(
                        (
                            route.route_id or route.vehicle_id,
                            tuple(
                                (stop.stop_type, stop.order_id)
                                for stop in route.stops
                            ),
                        )
                        for route in routes
                    )
                )
                previous = distinct_assignments.get(signature)
                route_cost = sum(
                    route.cost.total_cost_vnd
                    for route in routes
                    if route.cost is not None
                )
                previous_cost = (
                    sum(
                        route.cost.total_cost_vnd
                        for route in previous
                        if route.cost is not None
                    )
                    if previous is not None
                    else None
                )
                if previous_cost is None or route_cost < previous_cost:
                    distinct_assignments[signature] = routes
                return

            next_order_id = min(
                all_order_ids - covered_order_ids,
                key=lambda order_id: len(options_by_order[order_id]),
            )
            for vehicle_index, option_order_ids, route in options_by_order[next_order_id]:
                if vehicle_index in used_vehicle_indices:
                    continue
                if covered_order_ids.intersection(option_order_ids):
                    continue
                enumerate_assignments(
                    covered_order_ids.union(option_order_ids),
                    used_vehicle_indices.union((vehicle_index,)),
                    selected_routes + [route],
                )
                if time.monotonic() >= deadline:
                    assignment_enumeration_completed = False
                    return

        enumerate_assignments(frozenset(), frozenset(), [])
        completed = (
            routing_enumeration_completed
            and spatial_validation_completed
            and assignment_enumeration_completed
        )

        ranked_route_sets = sorted(
            distinct_assignments.values(),
            key=lambda routes: (
                sum(
                    route.cost.total_cost_vnd
                    for route in routes
                    if route.cost is not None
                ),
                sum(route.total_distance_km for route in routes),
                sum(route.total_duration_minutes for route in routes),
            ),
        )
        ranked = [
            self._response_from_exhaustive_routes(
                routes,
                completed=completed,
                routing_enumeration_completed=routing_enumeration_completed,
                spatial_validation_completed=spatial_validation_completed,
                assignment_enumeration_completed=assignment_enumeration_completed,
                route_sequences_evaluated=route_sequences_evaluated,
                complete_assignments_evaluated=complete_assignment_count,
            )
            for routes in ranked_route_sets[:max_candidates]
        ]
        return ExhaustiveSearchResult(
            plans=ranked[:max_candidates],
            completed=completed,
            routing_enumeration_completed=routing_enumeration_completed,
            spatial_validation_completed=spatial_validation_completed,
            assignment_enumeration_completed=assignment_enumeration_completed,
            route_sequences_evaluated=route_sequences_evaluated,
            complete_assignments_evaluated=complete_assignment_count,
        )

    def _response_from_exhaustive_routes(
        self,
        routes: List[OptimizedRoute],
        *,
        completed: bool,
        routing_enumeration_completed: bool,
        spatial_validation_completed: bool,
        assignment_enumeration_completed: bool,
        route_sequences_evaluated: int,
        complete_assignments_evaluated: int,
    ) -> FleetOptimizationResponse:
        total_distance_km = round(sum(route.total_distance_km for route in routes), 2)
        total_duration_minutes = round(
            sum(route.total_duration_minutes for route in routes), 1
        )
        total_cost_vnd = sum(
            route.cost.total_cost_vnd for route in routes if route.cost is not None
        )
        proof_diagnostic = (
            "Vét cạn đã duyệt hết không gian tuyến nhỏ trong mô hình; "
            "phương án hạng 1 là tối ưu trong không gian đã mô hình hóa."
            if completed
            else "Vét cạn chạm giới hạn thời gian hoặc giới hạn tìm bố trí; "
            "kết quả chỉ là nghiệm tốt nhất đã tìm thấy."
        )
        diagnostics = [
            proof_diagnostic,
            (
                f"Đã kiểm tra {route_sequences_evaluated} chuỗi pickup–delivery "
                f"và {complete_assignments_evaluated} phân công giao đủ đơn."
            ),
            "Mọi tuyến trả về đều đã qua validator tải, time window và xếp/dỡ hình học động.",
        ]
        if routing_enumeration_completed:
            diagnostics.append(
                "Tầng routing đã duyệt hết các chuỗi pickup–delivery và khung xe-ngày đủ điều kiện."
            )
        if not spatial_validation_completed:
            diagnostics.append(
                "Một số chuỗi bị chạm giới hạn tìm bố trí; không dùng chúng để kết luận bất khả thi."
            )
        if not assignment_enumeration_completed:
            diagnostics.append(
                "Tầng ghép tuyến–xe chạm ngân sách thời gian trước khi duyệt hết."
            )
        benchmarks = None
        try:
            benchmarks = BaselineCostCalculator(self.request, self.nodes).build_comparison(
                routes,
                total_cost_vnd,
                total_distance_km,
                total_duration_minutes,
                ortools_is_feasible=True,
                ortools_violations=[],
            )
        except Exception as error:
            diagnostics.append(f"Không tính được benchmark: {error}")

        return FleetOptimizationResponse(
            job_id=self.request.job_id,
            status="SUCCESS",
            routes=routes,
            total_distance_km=total_distance_km,
            total_duration_minutes=total_duration_minutes,
            total_cost_vnd=total_cost_vnd,
            benchmarks=benchmarks,
            diagnostics=diagnostics,
        )

    def solve_with_objective(self) -> Tuple[FleetOptimizationResponse, int]:
        """Run one OR-Tools search with ``self.search_strategy``.

        Returns the fully validated plan and the raw solver objective, which
        includes solver-only penalties and is not a financial cost.
        """
        if not self.driver_safe_vehicle_indices:
            return (
                FleetOptimizationResponse(
                    job_id=self.request.job_id,
                    status="INFEASIBLE",
                    unassigned_orders=self._unassigned_all(
                        "NO_COMPATIBLE_DRIVER",
                        "Không có cặp xe–tài xế nào đáp ứng hạng bằng lái.",
                    ),
                    diagnostics=[
                        "Không chạy solver vì không có xe nào ghép được với tài xế đủ hạng bằng."
                    ],
                ),
                0,
            )

        solve_started_at = time.monotonic()
        solve_deadline = solve_started_at + self.time_budget_seconds
        manager, routing, time_dimension = self._build_routing_model()
        progress = (
            SearchProgressTracker(self.stagnation_seconds)
            if self.stagnation_seconds is not None
            else None
        )
        stopped_for_stagnation = False
        if progress is not None:
            required_indices = [
                manager.NodeToIndex(self.vehicle_count + node_offset)
                for node_offset in range(2 * len(self.request.orders))
            ]

            def observe_solution() -> None:
                nonlocal stopped_for_stagnation
                elapsed_seconds = time.monotonic() - solve_started_at
                fully_served = all(
                    routing.ActiveVar(index).Value() == 1
                    for index in required_indices
                )
                progress.observe(
                    objective=int(routing.CostVar().Value()),
                    fully_served=fully_served,
                    elapsed_seconds=elapsed_seconds,
                )
                if progress.should_stop(elapsed_seconds):
                    stopped_for_stagnation = True
                    routing.solver().FinishCurrentSearch()

            routing.AddAtSolutionCallback(observe_solution)

        solution = routing.SolveWithParameters(
            self._build_search_parameters()
        )
        if solution is None:
            routing_status = routing.status()
            status = (
                "INFEASIBLE"
                if routing_status
                == routing_enums_pb2.RoutingSearchStatus.ROUTING_FAIL
                else "TIMEOUT"
            )
            return (
                FleetOptimizationResponse(
                    job_id=self.request.job_id,
                    status=status,
                    diagnostics=[
                        "Không tìm được nghiệm và OR-Tools chưa chứng minh bất khả thi trong ngân sách thời gian."
                        if status == "TIMEOUT"
                        else "OR-Tools đã trả ROUTING_FAIL cho các hard constraint đã cung cấp."
                    ],
                ),
                0,
            )

        if self.uses_adaptive_total_budget:
            remaining_seconds = max(0.1, solve_deadline - time.monotonic())
            validation_seconds = min(
                self.time_budget_seconds * self.validation_budget_share,
                remaining_seconds,
            )
            consolidation_seconds = min(
                self.time_budget_seconds * self.consolidation_budget_share,
                max(0.1, remaining_seconds - validation_seconds),
            )
        else:
            # Giữ hợp đồng thời gian của endpoint FleetRoutingSolver trực tiếp:
            # max_time_seconds trước đây chỉ giới hạn OR-Tools, còn validator có
            # ngân sách riêng. Multi-start tự động truyền time_budget_seconds và
            # dùng nhánh tổng ngân sách bị chặn ở trên.
            validation_seconds = max(
                8.0,
                min(20.0, self.time_budget_seconds * 0.25),
            )
            consolidation_seconds = min(
                25.0,
                max(8.0, self.time_budget_seconds * 0.25),
            )
        search_diagnostics = [
            (
                f"Lượt {self.search_strategy.label} dùng ngân sách "
                f"{'thích ứng ' if self.uses_adaptive_total_budget else ''}"
                f"{self.time_budget_seconds:g} giây."
            )
        ]
        if self.uses_adaptive_total_budget:
            search_diagnostics.append(
                "Phân bổ ngân sách: "
                f"routing {self.routing_budget_share * 100:g}%, "
                f"validator {self.validation_budget_share * 100:g}%, "
                f"gom tuyến {self.consolidation_budget_share * 100:g}%."
            )
        if stopped_for_stagnation:
            search_diagnostics.append(
                "Dừng sớm vì objective không cải thiện trong "
                f"{self.stagnation_seconds:g} giây sau khi đã có nghiệm giao đủ đơn ở tầng routing."
            )
        plan = self._finalize_candidate(
            self._drafts_from_assignment(manager, routing, time_dimension, solution),
            validation_seconds=max(0.1, validation_seconds),
            consolidation_seconds=max(0.1, consolidation_seconds),
            extra_diagnostics=search_diagnostics,
        )

        # Packing-aware ILS fallback: only replace the OR-Tools result with a
        # production-validated plan that serves more orders (or repairs a
        # spatially invalid result at the same service level).
        needs_ils = (
            len(plan.unassigned_orders) > 0
            or not plan.routes
            or any(not r.spatial_validation.is_valid for r in plan.routes)
        )
        if needs_ils:
            try:
                ils = PackingAwareILSOptimizer(
                    self.request,
                    time_budget_seconds=min(self.time_budget_seconds, 6.0),
                )
                ils_plan = ils.solve()
                ils_served = len(self.request.orders) - len(ils_plan.unassigned_orders)
                ortools_served = len(self.request.orders) - len(plan.unassigned_orders)
                ils_all_valid = all(r.spatial_validation.is_valid for r in ils_plan.routes) if ils_plan.routes else False
                ortools_all_valid = all(r.spatial_validation.is_valid for r in plan.routes) if plan.routes else False

                if (ils_served > ortools_served) or (
                    ils_served == ortools_served
                    and ils_all_valid
                    and not ortools_all_valid
                ):
                    plan = ils_plan
            except Exception as error:
                plan.diagnostics.append(f"Packing-aware ILS fallback lỗi: {error}")

        return plan, int(solution.ObjectiveValue())

    def _build_routing_model(
        self,
    ) -> Tuple[pywrapcp.RoutingIndexManager, pywrapcp.RoutingModel, pywrapcp.RoutingDimension]:
        vehicle_count = self.vehicle_count
        starts = list(range(vehicle_count))
        ends = list(range(vehicle_count))
        manager = pywrapcp.RoutingIndexManager(len(self.nodes), vehicle_count, starts, ends)
        routing = pywrapcp.RoutingModel(manager)

        def distance_callback(from_index: int, to_index: int) -> int:
            return int(round(self.request.distance_matrix_meters[
                manager.IndexToNode(from_index)
            ][manager.IndexToNode(to_index)]))

        distance_callback_index = routing.RegisterTransitCallback(distance_callback)
        routing.AddDimension(distance_callback_index, 0, 2_000_000, True, "Distance")
        distance_dimension = routing.GetDimensionOrDie("Distance")

        average_driver_per_km_vnd = sum(
            driver.per_km_pay_vnd for driver in self.request.drivers
        ) / len(self.request.drivers)
        average_driver_trip_base_vnd = sum(
            driver.trip_base_pay_vnd for driver in self.request.drivers
        ) / len(self.request.drivers)
        average_driver_time_vnd_per_second = sum(
            driver.fixed_salary_monthly_vnd
            / self.request.policy.monthly_working_minutes
            / 60
            for driver in self.request.drivers
        ) / len(self.request.drivers)

        for vehicle_index, vehicle in enumerate(self.request.vehicles):
            fuel_vnd_per_meter = (
                vehicle.fuel_consumption_liters_per_100_km
                * self.request.policy.fuel_price_per_liter_vnd
                / 100_000
            )
            driver_vnd_per_meter = average_driver_per_km_vnd / 1000
            financial_vnd_per_meter = fuel_vnd_per_meter + driver_vnd_per_meter

            def vehicle_cost(
                from_index: int,
                to_index: int,
                rate=financial_vnd_per_meter,
            ) -> int:
                from_node = manager.IndexToNode(from_index)
                to_node = manager.IndexToNode(to_index)
                distance = self.request.distance_matrix_meters[from_node][to_node]
                base_cost = (
                    distance
                    if rate <= 0
                    else distance * rate * OBJECTIVE_COST_SCALE
                )
                return max(0, int(round(base_cost)))

            cost_callback = routing.RegisterTransitCallback(vehicle_cost)
            routing.SetArcCostEvaluatorOfVehicle(cost_callback, vehicle_index)

            # Phân bổ lương cứng tài xế theo thời gian vào chi phí cố định mở xe:
            # Chi phí cố định mở một chuyến xe thực tế bao gồm cố định xe + công chuyến tài xế + lương cứng tài xế.
            # Đưa vào fixed cost giúp solver ưu tiên gom đơn thay vì mở xe tràn lan.
            estimated_driver_trip_salary_vnd = average_driver_time_vnd_per_second * min(
                vehicle.available_end_sec - vehicle.available_start_sec,
                5 * 3600,
            )

            # Solver-only delay penalty: prefer the earliest service day and
            # spill into later days only when earlier daily slots are full.
            # This penalty is not reported as a financial operating cost.
            day_delay_penalty_vnd = (
                self.request.policy.unassigned_order_penalty_vnd
                // 1000
                * vehicle.service_day_index
            )
            routing.SetFixedCostOfVehicle(
                round(
                    (
                        vehicle.fixed_operating_cost_vnd
                        + average_driver_trip_base_vnd
                        + estimated_driver_trip_salary_vnd
                        + day_delay_penalty_vnd
                    )
                    * OBJECTIVE_COST_SCALE
                ),
                vehicle_index,
            )

        def time_callback(from_index: int, to_index: int) -> int:
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            return int(round(
                self.request.duration_matrix_seconds[from_node][to_node]
                + self.nodes[from_node]["service_time_sec"]
            ))

        time_callback_index = routing.RegisterTransitCallback(time_callback)
        max_time_horizon = 30 * 86400  # 30 ngày = 2.592.000 giây
        routing.AddDimension(time_callback_index, max_time_horizon, max_time_horizon, False, "Time")
        time_dimension = routing.GetDimensionOrDie("Time")
        for vehicle_index, vehicle in enumerate(self.request.vehicles):
            time_dimension.CumulVar(routing.Start(vehicle_index)).SetRange(
                vehicle.available_start_sec, vehicle.available_start_sec
            )
            time_dimension.CumulVar(routing.End(vehicle_index)).SetRange(
                vehicle.available_start_sec, vehicle.available_end_sec
            )
        driver_time_cost_coefficient = round(
            average_driver_time_vnd_per_second * OBJECTIVE_COST_SCALE
        )
        if driver_time_cost_coefficient > 0:
            time_dimension.SetSpanCostCoefficientForAllVehicles(driver_time_cost_coefficient)

        def demand_callback(from_index: int) -> int:
            node = self.nodes[manager.IndexToNode(from_index)]
            if node["order"] is None:
                return 0
            demand = sum(item.weight_kg for item in node["order"].items)
            return round(demand * WEIGHT_SCALE) * (1 if node["type"] == "PICKUP" else -1)

        demand_callback_index = routing.RegisterUnaryTransitCallback(demand_callback)
        routing.AddDimensionWithVehicleCapacity(
            demand_callback_index,
            0,
            [round(v.payload_limit_kg * WEIGHT_SCALE) for v in self.request.vehicles],
            True,
            "Weight",
        )

        for vehicle_index, vehicle in enumerate(self.request.vehicles):
            extra_fuel_vnd_per_kg_meter = (
                vehicle.fuel_consumption_liters_per_100_km
                * (vehicle.load_fuel_surcharge_percent_at_full_payload / 100)
                * self.request.policy.fuel_price_per_liter_vnd
                / 100_000
                / vehicle.payload_limit_kg
            )
            load_energy_cost_coefficient = round(
                extra_fuel_vnd_per_kg_meter
                * OBJECTIVE_COST_SCALE
                / WEIGHT_SCALE
            )
            if load_energy_cost_coefficient > 0:
                # OR-Tools evaluates Weight.CumulVar(Next(node)) *
                # Distance.TransitVar(node), i.e. the load actually carried on
                # each road leg after applying pickup/delivery at the origin.
                routing.SetPathEnergyCostOfVehicle(
                    "Weight", "Distance", load_energy_cost_coefficient, vehicle_index
                )

        # Dimension 2: Floor Area (dm2 = 100 cm2)
        # Kiểm soát diện tích sàn xe thực tế, ngăn xe bị quá tải mặt sàn
        area_scale = 100
        def area_callback(from_index: int) -> int:
            node = self.nodes[manager.IndexToNode(from_index)]
            if node["order"] is None:
                return 0
            area = sum(item.length_cm * item.width_cm for item in node["order"].items)
            return round(area / area_scale) * (1 if node["type"] == "PICKUP" else -1)

        vehicle_capacities = []
        for vehicle in self.request.vehicles:
            vehicle_area = vehicle.length_cm * vehicle.width_cm
            max_fitting_order_area = max(
                (
                    sum(item.length_cm * item.width_cm for item in order.items)
                    for order in self.request.orders
                    if self._order_physically_fits_vehicle(order, vehicle)
                ),
                default=0.0,
            )
            usable_area = min(
                vehicle_area,
                max(max_fitting_order_area, vehicle_area * 0.88),
            )
            vehicle_capacities.append(round(usable_area / area_scale))

        area_callback_index = routing.RegisterUnaryTransitCallback(area_callback)
        routing.AddDimensionWithVehicleCapacity(
            area_callback_index,
            0,
            vehicle_capacities,
            True,
            "Area",
        )

        pair_penalty = (
            self.request.policy.unassigned_order_penalty_vnd * OBJECTIVE_COST_SCALE
        )
        for order_index, order in enumerate(self.request.orders):
            pickup_node = vehicle_count + 2 * order_index
            delivery_node = pickup_node + 1
            pickup_index = manager.NodeToIndex(pickup_node)
            delivery_index = manager.NodeToIndex(delivery_node)

            allowed_vehicle_indices = sorted(
                index
                for index in self.driver_safe_vehicle_indices
                if self._order_allows_vehicle(order, self.request.vehicles[index])
            )
            if allowed_vehicle_indices:
                routing.SetAllowedVehiclesForIndex(
                    allowed_vehicle_indices, pickup_index
                )
                routing.SetAllowedVehiclesForIndex(
                    allowed_vehicle_indices, delivery_index
                )
            elif order.allowed_source_vehicle_ids:
                routing.solver().Add(routing.ActiveVar(pickup_index) == 0)
                routing.solver().Add(routing.ActiveVar(delivery_index) == 0)

            routing.AddPickupAndDelivery(pickup_index, delivery_index)
            routing.solver().Add(
                routing.VehicleVar(pickup_index) == routing.VehicleVar(delivery_index)
            )
            routing.solver().Add(
                distance_dimension.CumulVar(pickup_index)
                <= distance_dimension.CumulVar(delivery_index)
            )
            routing.solver().Add(
                time_dimension.CumulVar(pickup_index) <= time_dimension.CumulVar(delivery_index)
            )
            routing.solver().Add(
                routing.ActiveVar(pickup_index) == routing.ActiveVar(delivery_index)
            )
            routing.AddDisjunction([pickup_index], pair_penalty // 2)
            routing.AddDisjunction([delivery_index], pair_penalty - pair_penalty // 2)

            time_dimension.CumulVar(pickup_index).SetRange(
                max(0, order.pickup_window_start_sec),
                min(max_time_horizon, order.pickup_window_end_sec),
            )
            time_dimension.CumulVar(delivery_index).SetRange(
                max(0, order.delivery_window_start_sec),
                min(max_time_horizon, order.delivery_window_end_sec),
            )

            daily_late_penalty = late_delivery_daily_penalty(
                order, self.request.policy
            )
            late_penalty_per_second = round(
                daily_late_penalty * OBJECTIVE_COST_SCALE / 86_400
            )
            if late_penalty_per_second > 0:
                grace_end_sec = max(
                    0,
                    order.ordered_at_sec
                    + self.request.policy.delivery_grace_days * 86_400,
                )
                time_dimension.SetCumulVarSoftUpperBound(
                    delivery_index, grace_end_sec, late_penalty_per_second
                )

            cargo_weight_kg = sum(item.weight_kg for item in order.items)
            cargo_holding_cost_coefficient = round(
                self.request.policy.cargo_holding_cost_vnd_per_ton_hour
                * cargo_weight_kg
                * OBJECTIVE_COST_SCALE
                / (1000 * 3600)
            )
            if cargo_holding_cost_coefficient > 0:
                # The two soft bounds add a route-independent constant plus
                # coefficient * (delivery_time - pickup_time). This includes
                # waiting imposed by time windows, unlike a plain arc callback.
                time_dimension.SetCumulVarSoftLowerBound(
                    pickup_index, max_time_horizon, cargo_holding_cost_coefficient
                )
                time_dimension.SetCumulVarSoftUpperBound(
                    delivery_index, 0, cargo_holding_cost_coefficient
                )

        split_groups: Dict[str, List[int]] = {}
        for order_index, order in enumerate(self.request.orders):
            if order.split_group_id:
                split_groups.setdefault(order.split_group_id, []).append(order_index)
        for order_indices in split_groups.values():
            first_pickup = manager.NodeToIndex(vehicle_count + 2 * order_indices[0])
            for order_index in order_indices[1:]:
                pickup = manager.NodeToIndex(vehicle_count + 2 * order_index)
                routing.solver().Add(
                    routing.ActiveVar(first_pickup) == routing.ActiveVar(pickup)
                )

        return manager, routing, time_dimension

    def _build_search_parameters(self):
        search = pywrapcp.DefaultRoutingSearchParameters()
        search.first_solution_strategy = (
            self.search_strategy.first_solution_strategy
        )
        search.local_search_metaheuristic = (
            self.search_strategy.local_search_metaheuristic
        )
        routing_budget_seconds = max(
            0.1, self.time_budget_seconds * self.routing_budget_share
        )
        search.time_limit.seconds = int(routing_budget_seconds)
        search.time_limit.nanos = int(
            (routing_budget_seconds - int(routing_budget_seconds)) * 1_000_000_000
        )
        return search

    def _build_stop_action(self, node_index: int, sequence: int) -> StopAction:
        node = self.nodes[node_index]
        order = node["order"]
        is_pickup = node["type"] == "PICKUP"
        return StopAction(
            stop_id=node["id"],
            sequence=sequence,
            stop_type=node["type"],
            address=node["name"],
            latitude=node["lat"],
            longitude=node["lon"],
            items_to_load=order.items if is_pickup else [],
            items_to_unload=[] if is_pickup else [item.id for item in order.items],
        )

    @staticmethod
    def _build_scheduled_stop(
        action: StopAction,
        order: OrderPair,
        arrival_sec: float,
        current_weight_kg: float,
        travel_time_sec: int,
        waiting_time_sec: int,
    ) -> ScheduledStop:
        return ScheduledStop(
            sequence=action.sequence,
            location_id=action.stop_id,
            location_name=action.address,
            stop_type=action.stop_type,
            order_id=order.source_order_id or order.id,
            allocation_id=order.id,
            order_stop_id=(
                order.pickup_location.source_location_id
                if action.stop_type == "PICKUP"
                else order.delivery_location.source_location_id
            )
            or action.stop_id,
            latitude=action.latitude,
            longitude=action.longitude,
            arrival_time_sec=round(arrival_sec),
            departure_time_sec=round(arrival_sec + order.service_time_sec),
            travel_time_sec=travel_time_sec,
            waiting_time_sec=waiting_time_sec,
            service_time_sec=order.service_time_sec,
            items_loaded=[item.id for item in action.items_to_load],
            items_unloaded=action.items_to_unload,
            current_weight_kg=round(max(0.0, current_weight_kg), 2),
        )

    def _drafts_from_assignment(
        self,
        manager: pywrapcp.RoutingIndexManager,
        routing: pywrapcp.RoutingModel,
        time_dimension: pywrapcp.RoutingDimension,
        solution,
    ) -> List[RouteDraft]:
        """Read routes and OR-Tools' own time schedule from the best assignment."""
        drafts: List[RouteDraft] = []
        for vehicle_index in range(self.vehicle_count):
            index = routing.Start(vehicle_index)
            route_start_seconds = solution.Value(time_dimension.CumulVar(index))
            route_distance_meters = 0.0
            return_travel_time_sec = 0
            return_waiting_time_sec = 0
            scheduled_stops: List[ScheduledStop] = []
            stop_actions: List[StopAction] = []
            route_order_ids: Set[str] = set()
            current_weight = 0.0

            while not routing.IsEnd(index):
                current_index = index
                next_index = solution.Value(routing.NextVar(index))
                from_node = manager.IndexToNode(current_index)
                to_node = manager.IndexToNode(next_index)
                current_cumul = solution.Value(time_dimension.CumulVar(current_index))
                next_cumul = solution.Value(time_dimension.CumulVar(next_index))
                travel_time_sec = int(round(
                    self.request.duration_matrix_seconds[from_node][to_node]
                ))
                waiting_time_sec = max(
                    0,
                    next_cumul
                    - current_cumul
                    - self.nodes[from_node]["service_time_sec"]
                    - travel_time_sec,
                )
                route_distance_meters += self.request.distance_matrix_meters[from_node][to_node]
                index = next_index
                if routing.IsEnd(next_index):
                    return_travel_time_sec = travel_time_sec
                    return_waiting_time_sec = waiting_time_sec
                    continue
                order = self.nodes[to_node]["order"]
                if order is None:
                    continue
                action = self._build_stop_action(to_node, len(stop_actions) + 1)
                delta = sum(item.weight_kg for item in order.items)
                current_weight += delta if action.stop_type == "PICKUP" else -delta
                route_order_ids.add(order.id)
                stop_actions.append(action)
                scheduled_stops.append(
                    self._build_scheduled_stop(
                        action,
                        order,
                        next_cumul,
                        current_weight,
                        travel_time_sec,
                        waiting_time_sec,
                    )
                )

            if not scheduled_stops:
                continue
            drafts.append(
                RouteDraft(
                    vehicle_index=vehicle_index,
                    start_time_sec=route_start_seconds,
                    end_time_sec=solution.Value(
                        time_dimension.CumulVar(routing.End(vehicle_index))
                    ),
                    distance_meters=route_distance_meters,
                    return_travel_time_sec=return_travel_time_sec,
                    return_waiting_time_sec=return_waiting_time_sec,
                    scheduled_stops=scheduled_stops,
                    stop_actions=stop_actions,
                    order_ids=route_order_ids,
                )
            )
        return drafts

    def _finalize_candidate(
        self,
        drafts: List[RouteDraft],
        *,
        validation_seconds: float,
        consolidation_seconds: float,
        extra_diagnostics: Optional[List[str]] = None,
    ) -> FleetOptimizationResponse:
        routes: List[OptimizedRoute] = []
        assigned_order_ids: Set[str] = set()
        rejected_reasons: Dict[str, Tuple[str, str]] = {}

        # Cấp ngân sách độc lập cho giai đoạn thẩm định hình học và phục hồi tuyến,
        # tránh để một tuyến phức tạp làm cạn kiệt toàn bộ thời gian của các xe còn lại.
        validation_deadline = time.monotonic() + validation_seconds

        for draft_position, draft in enumerate(drafts):
            if time.monotonic() >= validation_deadline:
                break
            vehicle_index = draft.vehicle_index
            vehicle = self.request.vehicles[vehicle_index]
            route_start_seconds = draft.start_time_sec
            route_distance_meters = draft.distance_meters
            return_travel_time_sec = draft.return_travel_time_sec
            return_waiting_time_sec = draft.return_waiting_time_sec
            scheduled_stops = draft.scheduled_stops
            stop_actions = draft.stop_actions
            route_order_ids = set(draft.order_ids)

            remaining_active = len(drafts) - draft_position
            remaining_seconds = validation_deadline - time.monotonic()
            if remaining_seconds <= 0:
                for order_id in route_order_ids:
                    rejected_reasons[order_id] = (
                        "VALIDATION_TIMEOUT",
                        "Hết ngân sách trước khi hoàn tất kiểm tra bố trí; chưa kết luận bất khả thi.",
                    )
                break

            vehicle_budget = max(
                1.0, remaining_seconds / max(1, remaining_active)
            )
            vehicle_deadline = min(
                validation_deadline, time.monotonic() + vehicle_budget
            )

            spatial_remaining_seconds = max(
                0.05,
                vehicle_deadline - time.monotonic(),
            )
            spatial = SpatialValidator(
                vehicle,
                max_time_seconds=min(
                    2.0,
                    spatial_remaining_seconds,
                    max(0.05, vehicle_budget * 0.8),
                ),
            ).validate_plan(stop_actions)
            if not spatial.is_valid:
                # Phối hợp định tuyến & bố trí hàng: tìm kiếm hoán vị chuỗi stop không bị chắn lối ra cửa (T24/T26)
                orders_on_route = [self.order_by_id[oid] for oid in route_order_ids if oid in self.order_by_id]
                reseq = self._resequence_stops_for_spatial_feasibility(
                    vehicle,
                    vehicle_index,
                    orders_on_route,
                    deadline=vehicle_deadline,
                )
                if reseq is not None:
                    scheduled_stops, stop_actions, route_distance_meters, route_end_seconds, spatial = reseq
                    return_travel_time_sec = max(
                        0,
                        round(route_end_seconds) - scheduled_stops[-1].departure_time_sec,
                    )
                    return_waiting_time_sec = 0
                elif len(orders_on_route) > 1:
                    # Fallback thông minh: Thử loại bớt 1 đơn để xe vẫn phục vụ được các đơn còn lại
                    sub_reseq = None
                    dropped_order_id = None
                    for sub in itertools.combinations(orders_on_route, len(orders_on_route) - 1):
                        sub_attempt = self._resequence_stops_for_spatial_feasibility(
                            vehicle,
                            vehicle_index,
                            list(sub),
                            deadline=vehicle_deadline,
                        )
                        if sub_attempt is not None:
                            sub_reseq = sub_attempt
                            dropped_order_id = next(o.id for o in orders_on_route if o.id not in {x.id for x in sub})
                            break
                    if sub_reseq is not None:
                        scheduled_stops, stop_actions, route_distance_meters, route_end_seconds, spatial = sub_reseq
                        return_travel_time_sec = max(
                            0,
                            round(route_end_seconds) - scheduled_stops[-1].departure_time_sec,
                        )
                        return_waiting_time_sec = 0
                        rejected_reasons[dropped_order_id] = (
                            "SPATIAL_ROUTE_CONFLICT",
                            "Đơn xung đột bố trí với tuyến ban đầu; sẽ thử tái phân công sang tuyến khác.",
                        )
                        route_order_ids = {
                            self._stop_allocation_id(stop)
                            for stop in scheduled_stops
                            if self._stop_allocation_id(stop)
                        }
                    else:
                        for order_id in route_order_ids:
                            rejected_reasons[order_id] = self._spatial_rejection(spatial)
                        continue
                else:
                    for order_id in route_order_ids:
                        rejected_reasons[order_id] = self._spatial_rejection(spatial)
                    continue
            else:
                route_end_seconds = draft.end_time_sec
            route_end_seconds = round(route_end_seconds)
            route_duration_seconds = route_end_seconds - route_start_seconds
            routes.append(
                OptimizedRoute(
                    route_id=vehicle.id,
                    vehicle_id=vehicle.source_vehicle_id or vehicle.id,
                    service_day_index=vehicle.service_day_index,
                    start_time_sec=route_start_seconds,
                    end_time_sec=route_end_seconds,
                    plate_number=vehicle.plate_number,
                    vehicle_length_cm=vehicle.length_cm,
                    vehicle_width_cm=vehicle.width_cm,
                    total_distance_km=round(route_distance_meters / 1000, 2),
                    total_duration_minutes=round(route_duration_seconds / 60, 1),
                    return_travel_time_sec=return_travel_time_sec,
                    return_waiting_time_sec=return_waiting_time_sec,
                    stops=scheduled_stops,
                    spatial_validation=spatial,
                )
            )
            assigned_order_ids.update(route_order_ids)

        recovery_limit_reached = self._recover_unassigned_orders(
            routes,
            assigned_order_ids,
            rejected_reasons,
            deadline=validation_deadline,
        )

        self._drop_incomplete_split_groups(
            routes,
            assigned_order_ids,
            rejected_reasons,
        )

        if routes and len(assigned_order_ids) == len(self.request.orders):
            self._consolidate_routes(
                routes,
                deadline=time.monotonic() + consolidation_seconds,
            )

        self._assign_drivers_and_costs(routes)

        unassigned: List[UnassignedOrder] = []
        reported_source_orders: Set[str] = set()
        for order in self.request.orders:
            if order.id in assigned_order_ids:
                continue
            source_order_id = self._source_order_id(order)
            if source_order_id in reported_source_orders:
                continue
            reported_source_orders.add(source_order_id)
            rejected_reason = rejected_reasons.get(order.id)
            if recovery_limit_reached and (
                rejected_reason is None
                or rejected_reason[0] == "SPATIAL_ROUTE_CONFLICT"
            ):
                code = "RECOVERY_SEARCH_LIMIT_REACHED"
                message = "Hết ngân sách tìm kiếm tái phân công; chưa kết luận đơn bất khả thi."
            elif rejected_reason is not None:
                code, message = rejected_reason
            else:
                code, message = self._classify_unassigned_order(order)
            unassigned.append(
                UnassignedOrder(
                    order_id=source_order_id,
                    order_number=order.source_order_number or order.order_number,
                    reason_code=code,
                    reason_message=message,
                )
            )

        result_status = (
            "SUCCESS"
            if routes and not unassigned
            else "PARTIAL"
            if routes
            else "TIMEOUT"
            if recovery_limit_reached
            else "INFEASIBLE"
        )
        total_dist_km = round(sum(route.total_distance_km for route in routes), 2)
        total_dur_min = round(sum(route.total_duration_minutes for route in routes), 1)
        total_cost_vnd = sum(route.cost.total_cost_vnd for route in routes if route.cost)

        benchmarks = None
        benchmark_diagnostic = None
        try:
            baseline_calc = BaselineCostCalculator(self.request, self.nodes)
            benchmarks = baseline_calc.build_comparison(
                routes,
                total_cost_vnd,
                total_dist_km,
                total_dur_min,
                ortools_is_feasible=not unassigned and all(
                    route.spatial_validation.is_valid for route in routes
                ),
                ortools_violations=[
                    f"{order.order_number}: {order.reason_message}"
                    for order in unassigned
                ],
            )
        except Exception as error:
            # Benchmark là dữ liệu phụ, nhưng lỗi phải hiện trong diagnostics thay vì bị nuốt.
            benchmark_diagnostic = f"Không tính được benchmark: {error}"

        return FleetOptimizationResponse(
            job_id=self.request.job_id,
            status=result_status,
            routes=routes,
            unassigned_orders=unassigned,
            total_distance_km=total_dist_km,
            total_duration_minutes=total_dur_min,
            total_cost_vnd=total_cost_vnd,
            benchmarks=benchmarks,
            diagnostics=[
                "Mục tiêu OR-Tools gồm nhiên liệu nền, phụ trội nhiên liệu theo tải từng chặng, "
                "thời gian/km tài xế và thời gian hàng nằm trên xe.",
                "Chi phí tài xế dùng mức bình quân đội xe khi tạo tuyến; sau đó ghép tài xế và "
                "tính lại bảng chi phí theo đúng tài xế được chọn.",
                "Kết quả là nghiệm khả thi tốt nhất tìm thấy trong thời gian cho phép, không khẳng định tối ưu toàn cục.",
            ]
            + (extra_diagnostics or [])
            + ([benchmark_diagnostic] if benchmark_diagnostic else []),
        )

    def _drop_incomplete_split_groups(
        self,
        routes: List[OptimizedRoute],
        assigned_order_ids: Set[str],
        rejected_reasons: Dict[str, Tuple[str, str]],
    ) -> None:
        groups: Dict[str, Set[str]] = {}
        for order in self.request.orders:
            if order.split_group_id:
                groups.setdefault(order.split_group_id, set()).add(order.id)

        incomplete_ids: Set[str] = set()
        for allocation_ids in groups.values():
            assigned = allocation_ids.intersection(assigned_order_ids)
            if assigned and assigned != allocation_ids:
                incomplete_ids.update(allocation_ids)
        if not incomplete_ids:
            return

        rebuilt_routes: List[OptimizedRoute] = []
        vehicle_index_by_id = {
            vehicle.id: index for index, vehicle in enumerate(self.request.vehicles)
        }
        node_id_to_idx = {
            node["id"]: index for index, node in enumerate(self.nodes)
        }
        for route in routes:
            route_id = route.route_id or route.vehicle_id
            vehicle_index = vehicle_index_by_id.get(route_id)
            if vehicle_index is None:
                continue
            vehicle = self.request.vehicles[vehicle_index]
            sequence = []
            remaining_ids: Set[str] = set()
            for stop in route.stops:
                allocation_id = self._stop_allocation_id(stop)
                if not allocation_id or allocation_id in incomplete_ids:
                    continue
                order = self.order_by_id.get(allocation_id)
                if order is None:
                    continue
                remaining_ids.add(allocation_id)
                sequence.append((allocation_id, stop.stop_type, order))
            if not sequence:
                continue

            actions = self._actions_from_precedence_sequence(sequence)
            evaluated = self._evaluate_resequence_candidate(
                vehicle, vehicle_index, actions, node_id_to_idx
            )
            spatial = SpatialValidator(vehicle).validate_plan(actions)
            if evaluated is None or not spatial.is_valid:
                assigned_order_ids.difference_update(remaining_ids)
                for allocation_id in remaining_ids:
                    rejected_reasons[allocation_id] = (
                        "SPLIT_GROUP_ROLLBACK_FAILED",
                        "Không thể giữ tuyến hợp lệ sau khi thu hồi một đơn chia xe chưa đủ phần.",
                    )
                continue
            scheduled, distance_meters, _, route_end_seconds = evaluated
            rebuilt_routes.append(
                self._build_candidate_route(
                    vehicle,
                    scheduled,
                    distance_meters,
                    route_end_seconds,
                    spatial,
                )
            )

        routes[:] = rebuilt_routes
        assigned_order_ids.difference_update(incomplete_ids)
        for allocation_id in incomplete_ids:
            rejected_reasons[allocation_id] = (
                "SPLIT_ORDER_NOT_FULLY_ASSIGNED",
                "Không thể phân bổ đầy đủ mọi kiện của đơn sang các xe khác nhau; không áp dụng phân công một phần.",
            )

    @staticmethod
    def _spatial_rejection(
        spatial: SpatialValidationResult,
    ) -> Tuple[str, str]:
        if spatial.violation_code == "PLACEMENT_SEARCH_LIMIT_REACHED":
            return (
                "SPATIAL_SEARCH_LIMIT_REACHED",
                spatial.error_message
                or "Hết ngân sách tìm bố trí; chưa kết luận chuyến bất khả thi.",
            )
        return (
            "SPATIAL_VALIDATION_FAILED",
            spatial.error_message or "Bố trí xếp/dỡ không hợp lệ.",
        )

    def _recover_unassigned_orders(
        self,
        routes: List[OptimizedRoute],
        assigned_order_ids: Set[str],
        rejected_reasons: Dict[str, Tuple[str, str]],
        *,
        deadline: float,
    ) -> bool:
        """Try every vehicle, including vehicles already used by another route.

        OR-Tools only models aggregate floor area. A route can therefore be
        rejected by the exact spatial validator after routing. Recovery must
        reinsert the dropped order across the whole fleet instead of looking
        only at idle vehicles.
        """
        vehicle_index_by_id = {
            vehicle.id: index for index, vehicle in enumerate(self.request.vehicles)
        }
        self._active_recovery_deadline = deadline
        limit_reached = False

        for order in self.request.orders:
            if order.id in assigned_order_ids:
                continue
            if time.monotonic() >= deadline:
                limit_reached = True
                break

            route_index_by_vehicle_id = {
                route.route_id or route.vehicle_id: index
                for index, route in enumerate(routes)
            }
            current_plan_cost = self._estimate_plan_total_cost(routes)
            candidate_vehicle_slots = sorted(
                enumerate(self.request.vehicles),
                key=lambda item: (
                    item[1].id in route_index_by_vehicle_id,
                    item[1].service_day_index,
                    item[0],
                ),
            )
            best_candidate = None
            for vehicle_index, vehicle in candidate_vehicle_slots:
                if vehicle_index not in self.driver_safe_vehicle_indices:
                    continue
                if not self._order_allows_vehicle(order, vehicle):
                    continue
                if time.monotonic() >= deadline:
                    limit_reached = True
                    break
                if not self._order_physically_fits_vehicle(order, vehicle):
                    continue

                route_index = route_index_by_vehicle_id.get(vehicle.id)
                if (
                    best_candidate is not None
                    and best_candidate[1] is None
                    and (
                        route_index is not None
                        or vehicle.service_day_index
                        > best_candidate[2].service_day_index
                    )
                ):
                    break
                existing_order_ids: List[str] = []
                if route_index is not None:
                    for stop in routes[route_index].stops:
                        if (
                            self._stop_allocation_id(stop)
                            and self._stop_allocation_id(stop) not in existing_order_ids
                        ):
                            existing_order_ids.append(self._stop_allocation_id(stop))

                candidate_orders = [
                    self.order_by_id[order_id]
                    for order_id in existing_order_ids
                    if order_id in self.order_by_id
                ] + [order]
                recovered = self._resequence_stops_for_spatial_feasibility(
                    vehicle,
                    vehicle_index,
                    candidate_orders,
                )
                if recovered is None:
                    continue

                scheduled, _, distance_meters, duration_seconds, spatial = recovered
                recovered_route = self._build_candidate_route(
                    vehicle,
                    scheduled,
                    distance_meters,
                    duration_seconds,
                    spatial,
                )
                candidate_routes = list(routes)
                if route_index is None:
                    candidate_routes.append(recovered_route)
                else:
                    candidate_routes[route_index] = recovered_route
                candidate_score = (
                    self._estimate_plan_total_cost(candidate_routes)
                    - current_plan_cost
                )
                if best_candidate is None or candidate_score < best_candidate[0]:
                    best_candidate = (
                        candidate_score,
                        route_index,
                        vehicle,
                        scheduled,
                        distance_meters,
                        duration_seconds,
                        spatial,
                    )

            if best_candidate is None:
                continue

            (
                _,
                route_index,
                vehicle,
                scheduled,
                distance_meters,
                duration_seconds,
                spatial,
            ) = best_candidate
            recovered_route = OptimizedRoute(
                route_id=vehicle.id,
                vehicle_id=vehicle.source_vehicle_id or vehicle.id,
                service_day_index=vehicle.service_day_index,
                start_time_sec=vehicle.available_start_sec,
                end_time_sec=round(duration_seconds),
                plate_number=vehicle.plate_number,
                vehicle_length_cm=vehicle.length_cm,
                vehicle_width_cm=vehicle.width_cm,
                total_distance_km=round(distance_meters / 1000, 2),
                total_duration_minutes=round(
                    (duration_seconds - vehicle.available_start_sec) / 60, 1
                ),
                return_travel_time_sec=max(
                    0,
                    round(duration_seconds) - scheduled[-1].departure_time_sec,
                ),
                return_waiting_time_sec=0,
                stops=scheduled,
                spatial_validation=spatial,
            )
            if route_index is None:
                routes.append(recovered_route)
            else:
                routes[route_index] = recovered_route
            assigned_order_ids.add(order.id)
            rejected_reasons.pop(order.id, None)

        # This lookup also guards against accidental route creation for an
        # unknown vehicle while the recovery code evolves.
        assert all((route.route_id or route.vehicle_id) in vehicle_index_by_id for route in routes)
        return limit_reached

    def _estimate_plan_total_cost(self, routes: List[OptimizedRoute]) -> int:
        if not routes:
            return 0
        candidates = [route.model_copy(deep=True) for route in routes]
        try:
            self._assign_drivers_and_costs(candidates)
        except ValueError:
            return 2**63 - 1
        return sum(
            route.cost.total_cost_vnd
            for route in candidates
            if route.cost is not None
        )

    @staticmethod
    def _build_candidate_route(
        vehicle: FleetVehicle,
        scheduled: List[ScheduledStop],
        distance_meters: float,
        route_end_seconds: float,
        spatial: SpatialValidationResult,
    ) -> OptimizedRoute:
        return OptimizedRoute(
            route_id=vehicle.id,
            vehicle_id=vehicle.source_vehicle_id or vehicle.id,
            service_day_index=vehicle.service_day_index,
            start_time_sec=vehicle.available_start_sec,
            end_time_sec=round(route_end_seconds),
            plate_number=vehicle.plate_number,
            vehicle_length_cm=vehicle.length_cm,
            vehicle_width_cm=vehicle.width_cm,
            total_distance_km=round(distance_meters / 1000, 2),
            total_duration_minutes=round(
                (route_end_seconds - vehicle.available_start_sec) / 60,
                1,
            ),
            return_travel_time_sec=max(
                0,
                round(route_end_seconds) - scheduled[-1].departure_time_sec,
            ),
            return_waiting_time_sec=0,
            stops=scheduled,
            spatial_validation=spatial,
        )

    def _consolidate_routes(
        self,
        routes: List[OptimizedRoute],
        *,
        deadline: float,
    ) -> None:
        """Greedily merge feasible routes when the full financial cost decreases."""
        vehicle_by_id = {vehicle.id: vehicle for vehicle in self.request.vehicles}
        max_merges = max(1, len(routes) - 1)
        merges = 0

        while len(routes) > 1 and merges < max_merges and time.monotonic() < deadline:
            current_plan_cost = self._estimate_plan_total_cost(routes)
            route_orders: List[List[OrderPair]] = []
            for route in routes:
                order_ids = list(
                    dict.fromkeys(
                        self._stop_allocation_id(stop)
                        for stop in route.stops
                        if self._stop_allocation_id(stop)
                    )
                )
                route_orders.append(
                    [
                        self.order_by_id[order_id]
                        for order_id in order_ids
                        if order_id in self.order_by_id
                    ]
                )

            pair_indices = list(itertools.combinations(range(len(routes)), 2))
            pair_indices.sort(
                key=lambda pair: (
                    0 if routes[pair[0]].service_day_index == routes[pair[1]].service_day_index else 1,
                    len(route_orders[pair[0]]) + len(route_orders[pair[1]]),
                    sum(
                        len(order.items)
                        for index in pair
                        for order in route_orders[index]
                    ),
                    routes[pair[0]].total_distance_km
                    + routes[pair[1]].total_distance_km,
                )
            )

            best_merge = None
            attempts = 0
            for left_index, right_index in pair_indices:
                if attempts >= 50 or time.monotonic() >= deadline:
                    break
                if routes[left_index].service_day_index != routes[right_index].service_day_index:
                    continue
                combined_orders = list(
                    {
                        order.id: order
                        for order in route_orders[left_index]
                        + route_orders[right_index]
                    }.values()
                )
                if not combined_orders:
                    continue

                candidate_vehicle_ids = list(
                    dict.fromkeys(
                        [
                            routes[left_index].route_id
                            or routes[left_index].vehicle_id,
                            routes[right_index].route_id
                            or routes[right_index].vehicle_id,
                        ]
                    )
                )
                candidate_vehicles = [
                    vehicle_by_id[vehicle_id]
                    for vehicle_id in candidate_vehicle_ids
                    if vehicle_id in vehicle_by_id
                ]
                day_index = routes[left_index].service_day_index
                used_plates_in_day = {
                    routes[idx].plate_number
                    for idx in range(len(routes))
                    if idx not in (left_index, right_index) and routes[idx].service_day_index == day_index
                }
                for v in self.request.vehicles:
                    if (
                        v.service_day_index == day_index
                        and v not in candidate_vehicles
                        and v.plate_number not in used_plates_in_day
                    ):
                        candidate_vehicles.append(v)

                candidate_vehicles.sort(
                    key=lambda vehicle: (
                        -(vehicle.length_cm * vehicle.width_cm),
                        -vehicle.payload_limit_kg,
                        vehicle.fixed_operating_cost_vnd,
                    )
                )

                for vehicle in candidate_vehicles:
                    if time.monotonic() >= deadline:
                        break
                    if not all(
                        self._order_physically_fits_vehicle(order, vehicle)
                        and self._order_allows_vehicle(order, vehicle)
                        for order in combined_orders
                    ):
                        continue
                    attempts += 1
                    vehicle_index = self.request.vehicles.index(vehicle)
                    recovered = self._resequence_stops_for_spatial_feasibility(
                        vehicle,
                        vehicle_index,
                        combined_orders,
                        deadline=deadline,
                    )
                    if recovered is None:
                        continue
                    scheduled, _, distance_meters, route_end_seconds, spatial = recovered
                    merged_route = self._build_candidate_route(
                        vehicle,
                        scheduled,
                        distance_meters,
                        route_end_seconds,
                        spatial,
                    )
                    candidate_routes = [
                        route
                        for index, route in enumerate(routes)
                        if index not in (left_index, right_index)
                    ] + [merged_route]
                    savings = (
                        current_plan_cost
                        - self._estimate_plan_total_cost(candidate_routes)
                    )
                    if savings <= 0:
                        continue
                    if best_merge is None or savings > best_merge[0]:
                        best_merge = (
                            savings,
                            left_index,
                            right_index,
                            vehicle,
                            scheduled,
                            distance_meters,
                            route_end_seconds,
                            spatial,
                        )

            if best_merge is None:
                return

            (
                _,
                left_index,
                right_index,
                vehicle,
                scheduled,
                distance_meters,
                route_end_seconds,
                spatial,
            ) = best_merge
            merged_route = self._build_candidate_route(
                vehicle,
                scheduled,
                distance_meters,
                route_end_seconds,
                spatial,
            )
            routes[left_index] = merged_route
            del routes[right_index]
            merges += 1

    @staticmethod
    def _order_physically_fits_vehicle(
        order: OrderPair, vehicle: FleetVehicle
    ) -> bool:
        if sum(item.weight_kg for item in order.items) > vehicle.payload_limit_kg:
            return False
        if (
            sum(item.length_cm * item.width_cm for item in order.items)
            > vehicle.length_cm * vehicle.width_cm
        ):
            return False
        for item in order.items:
            orientations = [(item.length_cm, item.width_cm)]
            if item.can_rotate:
                orientations.append((item.width_cm, item.length_cm))
            if item.height_cm > vehicle.height_cm or not any(
                length <= vehicle.length_cm and width <= vehicle.width_cm
                for length, width in orientations
            ):
                return False
        return True

    def _classify_unassigned_order(self, order: OrderPair) -> Tuple[str, str]:
        weight_compatible = [
            vehicle
            for index, vehicle in enumerate(self.request.vehicles)
            if index in self.driver_safe_vehicle_indices
            if self._order_allows_vehicle(order, vehicle)
            if sum(item.weight_kg for item in order.items)
            <= vehicle.payload_limit_kg
        ]
        if not weight_compatible:
            return (
                "PAYLOAD_EXCEEDED",
                "Khối lượng đơn vượt tải trọng của mọi xe khả dụng.",
            )

        physical_compatible = [
            vehicle
            for vehicle in weight_compatible
            if self._order_physically_fits_vehicle(order, vehicle)
        ]
        if not physical_compatible:
            return (
                "FLOOR_CAPACITY_EXCEEDED",
                "Kiện hàng không vừa kích thước hoặc diện tích sàn của mọi xe khả dụng.",
            )

        return (
            "NO_FEASIBLE_ASSIGNMENT",
            "Chưa tìm được cách ghép đơn vào các tuyến hiện tại trong ngân sách tìm kiếm; không khẳng định bất khả thi.",
        )

    def _assign_drivers_and_costs(self, routes: List[OptimizedRoute]) -> None:
        if not routes:
            return
        drivers = self.request.drivers
        vehicle_by_id = {vehicle.id: vehicle for vehicle in self.request.vehicles}

        def driver_cost(route: OptimizedRoute, driver: DriverOption) -> Tuple[int, int, int]:
            return calculate_driver_cost(
                self.request,
                driver,
                route.total_duration_minutes,
                route.total_distance_km,
            )

        for service_day_index in sorted({route.service_day_index for route in routes}):
            day_routes = [
                route for route in routes if route.service_day_index == service_day_index
            ]
            day_drivers = [
                driver for driver in drivers if driver.service_day_index == service_day_index
            ]
            best_assignment = None
            best_cost = None

            import numpy as np
            from scipy.optimize import linear_sum_assignment

            INF_COST = 10**15
            num_routes = len(day_routes)
            num_drivers = len(day_drivers)

            if num_drivers < num_routes:
                raise ValueError(
                    "Không thể ghép tài xế có hạng bằng lái phù hợp cho tất cả tuyến."
                )

            cost_matrix = np.full((num_routes, num_drivers), INF_COST, dtype=np.int64)

            for r_idx, route in enumerate(day_routes):
                vehicle = vehicle_by_id[route.route_id or route.vehicle_id]
                vehicle_type = vehicle.vehicle_type or vehicle.model or ""
                payload = vehicle.payload_limit_kg

                for d_idx, driver in enumerate(day_drivers):
                    if not can_driver_drive_vehicle(
                        driver.license_class, payload, vehicle_type
                    ):
                        continue
                    wage_cost = driver_cost(route, driver)[0]
                    cost_matrix[r_idx, d_idx] = wage_cost

            row_ind, col_ind = linear_sum_assignment(cost_matrix)

            for r_i, d_j in zip(row_ind, col_ind):
                if cost_matrix[r_i, d_j] >= INF_COST:
                    raise ValueError(
                        "Không thể ghép tài xế có hạng bằng lái phù hợp cho tất cả tuyến."
                    )

            best_assignment = [day_drivers[d_j] for _, d_j in sorted(zip(row_ind, col_ind), key=lambda p: p[0])]

            for route, driver in zip(day_routes, best_assignment):
                vehicle = vehicle_by_id[route.route_id or route.vehicle_id]
                route.driver_id = driver.source_driver_id or driver.id
                route.driver_name = driver.full_name
                route.driver_license_class = driver.license_class
                route.cost = build_route_cost_breakdown(
                    self.request,
                    self.nodes,
                    self.order_by_id,
                    vehicle,
                    driver,
                    route.stops,
                    route.total_distance_km,
                    route.total_duration_minutes,
                )

    def _calculate_route_economic_metrics(
        self, vehicle: FleetVehicle, stops: List[ScheduledStop]
    ) -> Tuple[int, int, int, float, float]:
        return calculate_route_economic_metrics(
            self.request,
            self.nodes,
            self.order_by_id,
            vehicle,
            stops,
        )

    def _generate_lifo_sequences(
        self, orders: List[any], deadline: Optional[float] = None
    ) -> List[List[Tuple[str, str, any]]]:
        """
        Sinh các chuỗi dừng thỏa mãn ràng buộc tiên quyết bốc trước dỡ (Pickup trước Delivery)
        cho mọi đơn hàng, hỗ trợ cả LIFO và FIFO khi bố trí không gian
        thùng xe cho phép dỡ độc lập ra cửa sau.
        """
        n = len(orders)
        valid_sequences = []

        def backtrack(current_seq, onboard, remaining_pickups):
            if deadline is not None and time.monotonic() >= deadline:
                return
            if len(current_seq) == 2 * n:
                valid_sequences.append(list(current_seq))
                return
            if len(valid_sequences) >= 600:
                return

            # 1. Có thể pickup thêm đơn hàng mới (nếu còn)
            for o in remaining_pickups:
                rem = [x for x in remaining_pickups if x.id != o.id]
                current_seq.append((o.id, "PICKUP", o))
                onboard.append(o.id)
                backtrack(current_seq, onboard, rem)
                onboard.pop()
                current_seq.pop()

            # 2. Có thể delivery bất kỳ đơn hàng nào đã được pickup (onboard)
            # Thử từ đơn bốc mới nhất (LIFO) đến các đơn bốc sớm hơn (FIFO)
            for i in reversed(range(len(onboard))):
                oid = onboard[i]
                target_order = next(o for o in orders if o.id == oid)
                rem_onboard = [x for idx, x in enumerate(onboard) if idx != i]
                current_seq.append((oid, "DELIVERY", target_order))
                backtrack(current_seq, rem_onboard, remaining_pickups)
                current_seq.pop()

        backtrack([], [], list(orders))
        return valid_sequences

    @staticmethod
    def _actions_from_precedence_sequence(
        sequence: List[Tuple[str, str, OrderPair]],
    ) -> List[StopAction]:
        actions: List[StopAction] = []
        for position, (_, stop_type, order) in enumerate(sequence, 1):
            if stop_type == "PICKUP":
                actions.append(
                    StopAction(
                        stop_id=order.pickup_location.id,
                        sequence=position,
                        stop_type="PICKUP",
                        address=order.pickup_location.name,
                        latitude=order.pickup_location.latitude,
                        longitude=order.pickup_location.longitude,
                        items_to_load=order.items,
                    )
                )
            else:
                actions.append(
                    StopAction(
                        stop_id=order.delivery_location.id,
                        sequence=position,
                        stop_type="DELIVERY",
                        address=order.delivery_location.name,
                        latitude=order.delivery_location.latitude,
                        longitude=order.delivery_location.longitude,
                        items_to_unload=[item.id for item in order.items],
                    )
                )
        return actions

    def _resequence_stops_for_spatial_feasibility(
        self,
        vehicle: FleetVehicle,
        vehicle_index: int,
        orders: List[any],
        *,
        deadline: Optional[float] = None,
    ) -> Optional[Tuple[List[ScheduledStop], List[StopAction], float, float, any]]:
        """
        Phối hợp định tuyến và bố trí hàng động (Mục 10.5 KE_HOACH_TMS.md):
        Khi lộ trình ban đầu của OR-Tools gây xung đột chắn lối ra cửa thùng (T24/T26),
        thuật toán tự động tìm kiếm hoán vị chuỗi dừng theo nguyên tắc LIFO tổng quát
        sao cho tối thiểu hóa quãng đường và vượt qua 100% kiểm định hình học của SpatialValidator.
        """
        if not orders:
            return None

        effective_deadline = (
            deadline
            or getattr(self, "_active_recovery_deadline", None)
            or (time.monotonic() + 8.0)
        )
        if time.monotonic() >= effective_deadline:
            return None

        node_id_to_idx = {node["id"]: idx for idx, node in enumerate(self.nodes)}

        lifo_sequences = self._generate_lifo_sequences(orders, effective_deadline)

        candidates = []
        for seq in lifo_sequences:
            if time.monotonic() >= effective_deadline:
                break
            cand_actions = self._actions_from_precedence_sequence(seq)

            evaluated = self._evaluate_resequence_candidate(
                vehicle, vehicle_index, cand_actions, node_id_to_idx
            )
            if evaluated is not None:
                candidates.append((evaluated[2], cand_actions, evaluated))

        # Sắp xếp các ứng viên khả thi theo chi phí tăng dần (ưu tiên chuỗi tối ưu nhất)
        candidates.sort(key=lambda c: c[0])

        def spatial_complexity(candidate) -> Tuple[int, int]:
            _, actions, _ = candidate
            onboard: Set[str] = set()
            peak_items = 0
            empty_boundaries = 0
            for action in actions:
                onboard.difference_update(action.items_to_unload)
                onboard.update(item.id for item in action.items_to_load)
                peak_items = max(peak_items, len(onboard))
                if not onboard:
                    empty_boundaries += 1
            # Lower peak occupancy is easier to verify; more empty boundaries
            # split the geometry into independent load cycles.
            return peak_items, -empty_boundaries

        # Do not spend the recovery budget only on the cheapest densely nested
        # routes. Try conservative candidates first, then use remaining time to
        # find a cheaper route that also passes the production validator.
        low_complexity = sorted(
            candidates,
            key=lambda candidate: (spatial_complexity(candidate), candidate[0]),
        )[:3]
        validation_candidates = []
        seen_sequences = set()
        for candidate in low_complexity + candidates[:3]:
            action_key = tuple(
                (action.stop_type, action.stop_id) for action in candidate[1]
            )
            if action_key not in seen_sequences:
                seen_sequences.add(action_key)
                validation_candidates.append(candidate)

        best_valid = None
        for score, cand_actions, evaluated in validation_candidates:
            remaining_seconds = effective_deadline - time.monotonic()
            if remaining_seconds <= 0:
                break
            val = SpatialValidator(
                vehicle,
                max_time_seconds=min(1.5, remaining_seconds),
                max_search_nodes=5000,
            )
            sp = val.validate_plan(cand_actions)
            if sp.is_valid:
                if best_valid is None or score < best_valid[0]:
                    best_valid = (score, cand_actions, evaluated, sp)

        if best_valid is not None:
            _, cand_actions, evaluated, sp = best_valid
            best_schedule, best_dist, best_score, best_duration = evaluated
            return best_schedule, cand_actions, best_dist, best_duration, sp

        return None

    def _evaluate_resequence_candidate(
        self,
        vehicle: FleetVehicle,
        vehicle_index: int,
        actions: List[StopAction],
        node_id_to_idx: Dict[str, int],
    ) -> Optional[Tuple[List[ScheduledStop], float, float, float]]:
        """Build and economically score a spatial fallback within vehicle availability."""
        scheduled: List[ScheduledStop] = []
        current_weight = 0.0
        current_area = 0.0
        max_vehicle_area = vehicle.length_cm * vehicle.width_cm
        current_time = float(vehicle.available_start_sec)
        previous_index = vehicle_index
        total_distance = 0.0
        item_weight_by_id = {
            item.id: item.weight_kg
            for order in self.request.orders
            for item in order.items
        }
        item_area_by_id = {
            item.id: item.length_cm * item.width_cm
            for order in self.request.orders
            for item in order.items
        }

        for action in actions:
            node_index = node_id_to_idx.get(action.stop_id)
            if node_index is None:
                return None
            node = self.nodes[node_index]
            order = node["order"]
            if order is None:
                return None

            leg_start = round(current_time)
            total_distance += self.request.distance_matrix_meters[previous_index][node_index]
            matrix_travel_time = self.request.duration_matrix_seconds[previous_index][node_index]
            current_time += matrix_travel_time
            window_start = (
                order.pickup_window_start_sec
                if action.stop_type == "PICKUP"
                else order.delivery_window_start_sec
            )
            window_end = (
                order.pickup_window_end_sec
                if action.stop_type == "PICKUP"
                else order.delivery_window_end_sec
            )
            current_time = max(current_time, float(window_start))
            arrival = current_time
            if arrival > window_end:
                return None
            if arrival > vehicle.available_end_sec:
                return None

            current_weight += sum(item.weight_kg for item in action.items_to_load)
            current_weight -= sum(
                item_weight_by_id.get(item_id, 0.0)
                for item_id in action.items_to_unload
            )
            if current_weight > vehicle.payload_limit_kg:
                return None

            current_area += sum(item.length_cm * item.width_cm for item in action.items_to_load)
            current_area -= sum(
                item_area_by_id.get(item_id, 0.0)
                for item_id in action.items_to_unload
            )
            if current_area > max_vehicle_area:
                return None

            departure = arrival + order.service_time_sec
            rounded_arrival = round(arrival)
            travel_time_sec = min(
                max(0, rounded_arrival - leg_start),
                max(0, round(matrix_travel_time)),
            )
            waiting_time_sec = max(
                0,
                rounded_arrival - leg_start - travel_time_sec,
            )
            scheduled.append(
                ScheduledStop(
                    sequence=action.sequence,
                    location_id=action.stop_id,
                    location_name=action.address,
                    stop_type=action.stop_type,
                    order_id=order.source_order_id or order.id,
                    allocation_id=order.id,
                    order_stop_id=(
                        order.pickup_location.source_location_id
                        if action.stop_type == "PICKUP"
                        else order.delivery_location.source_location_id
                    )
                    or action.stop_id,
                    latitude=action.latitude,
                    longitude=action.longitude,
                    arrival_time_sec=rounded_arrival,
                    departure_time_sec=rounded_arrival + order.service_time_sec,
                    travel_time_sec=travel_time_sec,
                    waiting_time_sec=waiting_time_sec,
                    service_time_sec=order.service_time_sec,
                    items_loaded=[item.id for item in action.items_to_load],
                    items_unloaded=action.items_to_unload,
                    current_weight_kg=round(max(0.0, current_weight), 2),
                )
            )
            current_time = departure
            previous_index = node_index

        total_distance += self.request.distance_matrix_meters[previous_index][vehicle_index]
        current_time += self.request.duration_matrix_seconds[previous_index][vehicle_index]
        if current_time > vehicle.available_end_sec:
            return None
        (
            base_fuel_cost,
            load_fuel_surcharge,
            cargo_holding_cost,
            _,
            _,
        ) = self._calculate_route_economic_metrics(vehicle, scheduled)
        average_driver_time_cost = sum(
            driver.fixed_salary_monthly_vnd
            * (current_time / 60)
            / self.request.policy.monthly_working_minutes
            for driver in self.request.drivers
        ) / len(self.request.drivers)
        average_driver_distance_cost = sum(
            driver.per_km_pay_vnd * (total_distance / 1000)
            for driver in self.request.drivers
        ) / len(self.request.drivers)
        economic_score = (
            base_fuel_cost
            + load_fuel_surcharge
            + cargo_holding_cost
            + average_driver_time_cost
            + average_driver_distance_cost
        )
        return scheduled, total_distance, economic_score, current_time


class OrToolsRoutingSolver:
    """Compatibility wrapper for the existing one-vehicle endpoint."""

    def __init__(self, request: OptimizationRequest):
        self.request = request

    def solve(self) -> OptimizationResponse:
        vehicle = FleetVehicle(
            **self.request.vehicle.model_dump(),
            depot=self.request.depot,
            fuel_consumption_liters_per_100_km=0,
            fixed_operating_cost_vnd=0,
        )
        fleet_request = FleetOptimizationRequest(
            job_id=self.request.job_id,
            vehicles=[vehicle],
            drivers=[
                DriverOption(
                    id="manual-driver-placeholder",
                    full_name="Điều phối thủ công",
                    fixed_salary_monthly_vnd=0,
                    trip_base_pay_vnd=0,
                    per_km_pay_vnd=0,
                )
            ],
            orders=self.request.orders,
            policy=CostPolicy(
                fuel_price_per_liter_vnd=1,
                monthly_working_minutes=1,
            ),
            max_time_seconds=self.request.max_time_seconds,
            distance_matrix_meters=self.request.distance_matrix_meters,
            duration_matrix_seconds=self.request.duration_matrix_seconds,
        )
        fleet_result = FleetRoutingSolver(fleet_request).solve()
        if fleet_result.routes:
            route = fleet_result.routes[0]
            return OptimizationResponse(
                job_id=self.request.job_id,
                status="SUCCESS" if fleet_result.status == "SUCCESS" else "PARTIAL",
                total_distance_km=route.total_distance_km,
                total_duration_minutes=route.total_duration_minutes,
                stops=route.stops,
                unassigned_order_ids=[item.order_id for item in fleet_result.unassigned_orders],
                spatial_validation=route.spatial_validation,
                diagnostics=fleet_result.diagnostics,
            )
        return OptimizationResponse(
            job_id=self.request.job_id,
            status="TIMEOUT" if fleet_result.status == "TIMEOUT" else "INFEASIBLE",
            unassigned_order_ids=[item.order_id for item in fleet_result.unassigned_orders],
            diagnostics=fleet_result.diagnostics,
        )
