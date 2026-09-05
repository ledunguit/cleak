#!/usr/bin/env python3
"""MemHint variance analysis — todo-3 helper (no numbers baked in).

Reads per-run rows.csv from results/memhint-llm-assisted-2026-08-28-run{1,2,3}/
(run-3 must be synced from wsl2 first), computes per-run P/R/F1 + mean±std,
optionally cross-checks a variance.json, and prints a FREEZE-row-10-ready
summary. Pure computation — run it after the gate opens.

Usage:
  python3 scripts/memhint-variance-analysis.py [--variance-json <path>] [--base-dir <dir>]
"""
import argparse
import csv
import json
import math
import pathlib
import sys

RUNS = [1, 2, 3]


def rows_path(base: pathlib.Path, run: int) -> pathlib.Path:
    return base / f"memhint-llm-assisted-2026-08-28-run{run}" / "rows.csv"


def summarize_run(run: int, path: pathlib.Path) -> dict:
    with path.open(newline="") as fh:
        rows = list(csv.DictReader(fh))
    ok = sum(1 for r in rows if r["status"] == "ok")
    tp = sum(int(r["tp"]) for r in rows)
    fp = sum(int(r["fp"]) for r in rows)
    fn = sum(int(r["fn"]) for r in rows)
    tin = sum(int(r["inputTokens"] or 0) for r in rows)
    tout = sum(int(r["outputTokens"] or 0) for r in rows)
    p = tp / (tp + fp) if (tp + fp) else 0.0
    r_ = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * tp / (2 * tp + fp + fn) if (2 * tp + fp + fn) else 0.0
    errs = [r["id"] for r in rows if r["status"] != "ok"]
    return {
        "run": run, "rows": len(rows), "ok": ok, "tp": tp, "fp": fp, "fn": fn,
        "P": p, "R": r_, "F1": f1, "tok_in": tin, "tok_out": tout,
        "errs": errs, "path": str(path),
    }


def mean_std(xs: list[float]) -> tuple[float, float]:
    n = len(xs)
    m = sum(xs) / n
    if n < 2:
        return m, 0.0
    var = sum((x - m) ** 2 for x in xs) / (n - 1)  # sample std, ddof=1
    return m, math.sqrt(var)


def cross_check_variance(vj: pathlib.Path, runs: list[dict]) -> list[str]:
    problems: list[str] = []
    try:
        data = json.loads(vj.read_text())
    except Exception as e:  # noqa: BLE001 — report, don't crash
        return [f"variance.json unreadable: {e}"]
    blob = json.dumps(data)
    for s in runs:
        for key in ("P", "R", "F1"):
            val = f"{s[key]:.3f}"
            if val not in blob and val.rstrip("0").rstrip(".") not in blob:
                problems.append(
                    f"run-{s['run']} {key}={val} not found in variance.json text"
                )
    return problems or ["variance.json values consistent with per-run rows"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-dir", default="results", help="dir containing run1..3 sync dirs")
    ap.add_argument("--variance-json", default=None,
                    help="path to wsl2 variance.json (copied) to cross-check")
    args = ap.parse_args()
    base = pathlib.Path(args.base_dir)

    runs: list[dict] = []
    missing = False
    for run in RUNS:
        p = rows_path(base, run)
        if not p.exists():
            print(f"run-{run}: MISSING {p} — rsync it from wsl2 first", file=sys.stderr)
            missing = True
            continue
        runs.append(summarize_run(run, p))
    if missing or len(runs) < 3:
        return 1

    for s in runs:
        print(f"run-{s['run']}: {s['rows']} rows ok={s['ok']} | "
              f"TP={s['tp']} FP={s['fp']} FN={s['fn']} | "
              f"P={s['P']:.3f} R={s['R']:.3f} F1={s['F1']:.3f} | "
              f"tok in={s['tok_in']:,} out={s['tok_out']:,} | "
              f"errs={s['errs'] or 'none'}")

    for key in ("P", "R", "F1"):
        m, sd = mean_std([s[key] for s in runs])
        print(f"{key}: mean={m:.3f} ± {sd:.3f}")

    tp_total = sum(s["tp"] for s in runs)
    fp_total = sum(s["fp"] for s in runs)
    print(f"matrix identity check: per-run (TP,FP,FN) sets = "
          f"{sorted({(s['tp'], s['fp'], s['fn']) for s in runs})}")

    if args.variance_json:
        vj = pathlib.Path(args.variance_json)
        if vj.exists():
            print("variance.json cross-check:", *cross_check_variance(vj, runs), sep="\n  ")
        else:
            print(f"variance-json not found at {vj} (skip cross-check)")

    print("\nFREEZE row 10 fill-in template:")
    for key in ("P", "R", "F1"):
        m, sd = mean_std([s[key] for s in runs])
        print(f"  {key} = {m:.3f}±{sd:.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
