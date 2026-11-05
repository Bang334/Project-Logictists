"""Read explicit benchmark switches without executing configuration as code."""

from configparser import ConfigParser, Error as ConfigError
from pathlib import Path
from typing import Sequence


# Stable IDs: adding a fixture must never renumber existing switches.
CASE_SWITCHES = {
    "TESTCASE1": "db_danang_30_orders.json",
    "TESTCASE2": "db_hanoi_16_orders.json",
    "TESTCASE3": "db_nhatrang_2_orders.json",
    "TESTCASE4": "db_songthan_4_orders.json",
    "TESTCASE5": "novel_1_mekong_hub_spoke.json",
    "TESTCASE6": "novel_2_long_narrow_timber.json",
    "TESTCASE7": "novel_3_three_shift_relay.json",
    "TESTCASE8": "novel_4_3tier_asymmetric_fleet.json",
    "TESTCASE9": "novel_5_rolling_3day_horizon.json",
    "TESTCASE10": "scenario_1_multi_item.json",
    "TESTCASE11": "scenario_2_heavy_cargo.json",
    "TESTCASE12": "scenario_3_dispersed.json",
    "TESTCASE13": "scenario_4_tight_windows.json",
    "TESTCASE14": "scenario_5_heterogeneous_fleet.json",
    "TESTCASE15": "scenario_6_dynamic_reuse.json",
    "TESTCASE16": "scenario_7_multi_depot_overnight.json",
    "TESTCASE17": "scenario_8_dense_fragmentation.json",
}


def load_selection(
    path: Path, available_cases: Sequence[str], available_engines: Sequence[str],
) -> tuple[list[str], list[str]]:
    config = ConfigParser(interpolation=None, inline_comment_prefixes=("#", ";"))
    config.optionxform = str
    try:
        with path.open(encoding="utf-8-sig") as stream:
            config.read_file(stream)
    except (OSError, ConfigError) as error:
        raise ValueError(f"Cannot read selection file {path}: {error}") from error
    if config.defaults() or set(config.sections()) != {"cases", "engines"}:
        raise ValueError("Selection file requires exactly [cases] and [engines], without DEFAULT")

    def enabled(section: str, allowed: Sequence[str]) -> list[str]:
        selected = []
        for key, value in config[section].items():
            if key not in allowed:
                raise ValueError(f"Unknown switch [{section}] {key}")
            if value not in {"0", "1"}:
                raise ValueError(f"[{section}] {key} must be 0 or 1, got {value!r}")
            if value == "1":
                selected.append(key)
        if not selected:
            raise ValueError(f"No enabled switches in [{section}]")
        return selected

    cases = [CASE_SWITCHES[key] for key in enabled("cases", list(CASE_SWITCHES))]
    missing = set(cases) - set(available_cases)
    if missing:
        raise ValueError(f"Selected fixtures do not exist: {sorted(missing)}")
    engines = enabled("engines", available_engines)
    return cases, engines
