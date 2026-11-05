"""Selective runs must never silently execute disabled or misspelled cases."""

from pathlib import Path
import json

import pytest

from benchmarks.algorithm_comparison.benchmark_selection import CASE_SWITCHES, load_selection
from benchmarks.algorithm_comparison.daytime_cases import list_case_files
from benchmarks.algorithm_comparison import run_daytime_benchmark as runner


def selection_file(tmp_path, cases="TESTCASE1=1\nTESTCASE2=0", engines="Hybrid ALNS=1\nILS=0"):
    path = tmp_path / "selection.ini"
    path.write_text(f"[cases]\n{cases}\n[engines]\n{engines}\n", encoding="utf-8-sig")
    return path


def test_switch_ids_match_the_documented_17_real_fixtures():
    assert len(CASE_SWITCHES) == len(set(CASE_SWITCHES.values())) == 17
    assert set(CASE_SWITCHES.values()) <= set(list_case_files())
    assert CASE_SWITCHES["TESTCASE16"] == "scenario_7_multi_depot_overnight.json"


def test_only_explicitly_enabled_case_and_engine_are_selected(tmp_path):
    path = selection_file(tmp_path, cases="TESTCASE1=0\nTESTCASE3=1 # small case")
    assert load_selection(path, list_case_files(), runner.ENGINES) == (
        ["db_nhatrang_2_orders.json"], ["Hybrid ALNS"],
    )


@pytest.mark.parametrize("cases,engines,message", [
    ("TESTCASE99=1", "ILS=1", "Unknown switch"),
    ("TESTCASE1=true", "ILS=1", "must be 0 or 1"),
    ("TESTCASE1=0", "ILS=1", "No enabled switches"),
    ("TESTCASE1=1", "ILS=0", "No enabled switches"),
    ("TESTCASE1=1", "Typo=1", "Unknown switch"),
    ("TESTCASE1=1\nTESTCASE1=0", "ILS=1", "Cannot read selection"),
])
def test_invalid_switches_fail_before_running(tmp_path, cases, engines, message):
    with pytest.raises(ValueError, match=message):
        load_selection(selection_file(tmp_path, cases, engines), list_case_files(), runner.ENGINES)


def test_selected_missing_fixture_is_an_error(tmp_path):
    with pytest.raises(ValueError, match="fixtures do not exist"):
        load_selection(selection_file(tmp_path), [], runner.ENGINES)


def test_wrong_section_cannot_silently_enable_everything(tmp_path):
    path = selection_file(tmp_path)
    path.write_text("[case]\nTESTCASE1=1\n[engines]\nILS=1", encoding="utf-8")
    with pytest.raises(ValueError, match="requires exactly"):
        load_selection(path, list_case_files(), runner.ENGINES)


def test_dry_run_never_calls_runner_or_creates_output(tmp_path, monkeypatch, capsys):
    path = selection_file(tmp_path)
    output = tmp_path / "results.json"
    def unexpected(*args):
        pytest.fail("dry run must not start any solvers")
    monkeypatch.setattr(runner, "run_benchmark", unexpected)
    runner.main(["--selection-file", str(path), "--seeds", "0", "--dry-run", "--output", str(output)])
    assert "1 cases x 1 seeds x 1 engines = 1 trials" in capsys.readouterr().out
    assert not output.exists()


def test_cli_dispatches_only_enabled_case_and_engine_to_fresh_outputs(tmp_path, monkeypatch):
    path = selection_file(tmp_path, cases="TESTCASE3=1\nTESTCASE1=0")
    calls = []
    monkeypatch.setattr(runner, "run_benchmark", lambda *args: calls.append(args))
    for _ in range(2):
        runner.main(["--selection-file", str(path), "--seeds", "0"])
    for cases, engines, seeds, budget, shift, output in calls:
        assert cases == ["db_nhatrang_2_orders.json"]
        assert engines == ["Hybrid ALNS"]
        assert seeds == [0]
        assert budget == 2.0
        assert output.name.startswith("daytime_selected_")
    assert calls[0][-1] != calls[1][-1]


def test_cli_filters_intersect_file_selection_and_reject_empty_result(tmp_path, monkeypatch):
    path = selection_file(tmp_path)
    calls = []
    monkeypatch.setattr(runner, "run_benchmark", lambda *args: calls.append(args))
    with pytest.raises(SystemExit) as error:
        runner.main(["--selection-file", str(path), "--cases", "nhatrang"])
    assert error.value.code == 2
    assert not calls


def test_no_selection_file_keeps_existing_full_run_behavior(monkeypatch):
    calls = []
    monkeypatch.setattr(runner, "run_benchmark", lambda *args: calls.append(args))
    runner.main(["--seeds", "0"])
    assert calls[0][0] == list_case_files()
    assert calls[0][1] == runner.ENGINES
    assert calls[0][-1] == runner.DEFAULT_OUTPUT


def test_shipped_preset_has_ten_historical_loss_cases():
    path = Path(runner.__file__).with_name("test_selection.ini")
    cases, engines = load_selection(path, list_case_files(), runner.ENGINES)
    assert len(cases) == 10
    assert "scenario_7_multi_depot_overnight.json" in cases
    assert "scenario_1_multi_item.json" not in cases
    assert engines == runner.ENGINES


@pytest.mark.parametrize("change", ["legacy_profile", "budget", "duplicate"])
def test_resume_rejects_incompatible_rows_without_overwriting_them(tmp_path, change):
    shift = runner.DaytimeShift()
    row = dict(case="saved",algorithm="Hybrid ALNS",seed=0,budget=2,
        objective_profile="production_v1",experiment_fingerprint=runner._experiment_fingerprint(2,shift))
    rows = [row]
    requested_budget = 2
    if change == "legacy_profile":
        row.pop("objective_profile")
    elif change == "budget":
        requested_budget = 10
    else:
        rows.append(dict(row))
    output = tmp_path / "results.json"
    original = json.dumps(rows)
    output.write_text(original, encoding="utf-8")
    with pytest.raises(ValueError):
        runner.run_benchmark([],runner.ENGINES,[0],requested_budget,shift,output)
    assert output.read_text(encoding="utf-8") == original
