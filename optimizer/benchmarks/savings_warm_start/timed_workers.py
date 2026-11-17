"""Own and reap independent solver processes for a bounded benchmark run."""

import faulthandler
import json
import multiprocessing
from multiprocessing.connection import wait
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from time import perf_counter
from typing import Any, Callable


def _run_and_publish(worker: Callable, task_path: Path, output: Path) -> None:
    try:
        task = json.loads(task_path.read_text(encoding="utf-8"))
        total_budget = max(0.0, task["publish_deadline"] - perf_counter())
        trace_margin = max(0.25, min(1.0, total_budget * 0.05))
        trace_delay = total_budget - trace_margin
        with output.with_suffix(".stack.txt").open("w", encoding="utf-8") as stack:
            if trace_delay > 0:
                faulthandler.dump_traceback_later(trace_delay, file=stack)
            try:
                result = {"value": worker(task), "finished_at": perf_counter()}
            finally:
                if trace_delay > 0:
                    faulthandler.cancel_dump_traceback_later()
    except Exception as error:
        result = {"error": f"{type(error).__name__}: {error}"}
    _publish(output, result)


def _publish(output: Path, result: dict[str, Any]) -> None:
    pending = output.with_suffix(".tmp")
    pending.write_text(json.dumps(result), encoding="utf-8")
    pending.replace(output)


def publish_checkpoint(output: str, value: dict[str, Any]) -> None:
    _publish(Path(output), {"value": value, "finished_at": perf_counter()})


def _near_deadline_frames(output: Path) -> str:
    trace = output.with_suffix(".stack.txt")
    if not trace.exists():
        return ""
    frames = re.findall(
        r'File "([^"]+)", line (\d+) in ([^\r\n]+)',
        trace.read_text(encoding="utf-8", errors="replace"),
    )
    return " > ".join(f"{Path(file).name}:{line} {name}" for file, line, name in frames[:5])


def run_timed_workers(
    worker: Callable,
    tasks: list[dict[str, Any]],
    deadline: float,
) -> tuple[list[dict[str, Any]], list[str], bool]:
    """Collect only fully published results and terminate overdue children."""
    ctx = multiprocessing.get_context("spawn")
    results = []
    errors = []
    timed_out = False
    with TemporaryDirectory(prefix="alns-portfolio-") as directory:
        processes = {}
        overdue = set()
        try:
            for index, task in enumerate(tasks):
                stream = str(task["stream"])
                if perf_counter() >= deadline:
                    errors.append(f"{stream}: deadline elapsed before launch")
                    timed_out = True
                    continue
                output = Path(directory) / f"{index}.json"
                checkpoint = output.with_suffix(".checkpoint.json")
                task_path = output.with_suffix(".input.json")
                task_path.write_text(json.dumps({
                    **task, "checkpoint_path": str(checkpoint), "publish_deadline": deadline,
                }), encoding="utf-8")
                process = ctx.Process(
                    target=_run_and_publish,
                    args=(worker, task_path, output),
                )
                try:
                    process.start()
                except OSError as error:
                    errors.append(f"{stream}: {error}")
                    process.close()
                    continue
                processes[process.sentinel] = (process, stream, output)
            pending = set(processes)
            while pending:
                remaining = deadline - perf_counter()
                if remaining <= 0:
                    break
                pending.difference_update(wait(pending, timeout=remaining))
        finally:
            for process, stream, _ in processes.values():
                if process.is_alive():
                    overdue.add(stream)
                    process.terminate()
                process.join()
        for process, stream, output in processes.values():
            eligible = []
            checkpoint = output.with_suffix(".checkpoint.json")
            if checkpoint.is_file():
                saved = json.loads(checkpoint.read_text(encoding="utf-8"))
                if saved["finished_at"] <= deadline:
                    eligible.append(saved["value"])
            if output.is_file():
                payload = json.loads(output.read_text(encoding="utf-8"))
                if "value" in payload and payload["finished_at"] <= deadline:
                    eligible.append(payload["value"])
                elif "value" in payload:
                    timed_out = True
                    errors.append(f"{stream}: audit finished after deadline")
                else:
                    errors.append(f"{stream}: {payload['error']}")
            elif stream in overdue:
                timed_out = True
                message = f"{stream}: stopped before final audit output"
                frames = _near_deadline_frames(output)
                errors.append(f"{message}; near deadline: {frames}" if frames else message)
            else:
                errors.append(f"{stream}: worker exited with code {process.exitcode}")
            if eligible:
                results.append(min(eligible, key=lambda value: value.get("quality", (0,))))
            process.close()
    return results, errors, timed_out
