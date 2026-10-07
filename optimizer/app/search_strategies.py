"""Independent OR-Tools search configurations used for parallel multi-start."""
from dataclasses import dataclass
from typing import Tuple

from ortools.constraint_solver import routing_enums_pb2

FirstSolution = routing_enums_pb2.FirstSolutionStrategy
Metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic


@dataclass(frozen=True)
class SearchStrategy:
    key: str
    label: str
    first_solution_strategy: int
    local_search_metaheuristic: int


# Ordered by expected quality on pickup/delivery problems; the first entry is
# the historical single-run configuration so a one-search run is unchanged.
SEARCH_STRATEGIES: Tuple[SearchStrategy, ...] = (
    SearchStrategy(
        key="parallel-insertion-gls",
        label="Chèn rẻ nhất song song + Guided Local Search",
        first_solution_strategy=FirstSolution.PARALLEL_CHEAPEST_INSERTION,
        local_search_metaheuristic=Metaheuristic.GUIDED_LOCAL_SEARCH,
    ),
    SearchStrategy(
        key="local-insertion-gls",
        label="Chèn rẻ nhất cục bộ + Guided Local Search",
        first_solution_strategy=FirstSolution.LOCAL_CHEAPEST_INSERTION,
        local_search_metaheuristic=Metaheuristic.GUIDED_LOCAL_SEARCH,
    ),
    SearchStrategy(
        key="path-cheapest-arc-gls",
        label="Cung rẻ nhất + Guided Local Search",
        first_solution_strategy=FirstSolution.PATH_CHEAPEST_ARC,
        local_search_metaheuristic=Metaheuristic.GUIDED_LOCAL_SEARCH,
    ),
    SearchStrategy(
        key="parallel-insertion-tabu",
        label="Chèn rẻ nhất song song + Tabu Search",
        first_solution_strategy=FirstSolution.PARALLEL_CHEAPEST_INSERTION,
        local_search_metaheuristic=Metaheuristic.TABU_SEARCH,
    ),
    SearchStrategy(
        key="parallel-insertion-annealing",
        label="Chèn rẻ nhất song song + Simulated Annealing",
        first_solution_strategy=FirstSolution.PARALLEL_CHEAPEST_INSERTION,
        local_search_metaheuristic=Metaheuristic.SIMULATED_ANNEALING,
    ),
    SearchStrategy(
        key="savings-gls",
        label="Savings + Guided Local Search",
        first_solution_strategy=FirstSolution.SAVINGS,
        local_search_metaheuristic=Metaheuristic.GUIDED_LOCAL_SEARCH,
    ),
)

DEFAULT_SEARCH_STRATEGY = SEARCH_STRATEGIES[0]


def find_search_strategy(key: str) -> SearchStrategy:
    for strategy in SEARCH_STRATEGIES:
        if strategy.key == key:
            return strategy
    raise ValueError(f"Unknown OR-Tools search strategy: {key}")
