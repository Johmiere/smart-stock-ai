"""Run a weekly academic benchmark separately from Smart Stock's operational store."""

import argparse
import csv
import io
import json
import math
import statistics
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from hashlib import sha256
from pathlib import Path
from urllib.request import Request, urlopen
from zipfile import ZipFile

BASE = (
    "https://www.chicagobooth.edu/research/kilts/research-data/-/media/"
    "enterprise/centers/kilts/datasets/dominicks-dataset/"
)
STORE = 2
WEEK_1 = date(1989, 9, 14)
HOLDOUT = 26
SOURCE = "Chicago Booth Kilts Center, Dominick's historical grocery scanner data"


def downloaded(folder, relative):
    save_to = folder / Path(relative).name
    if not save_to.exists():
        with urlopen(Request(BASE + relative, headers={"User-Agent": "Mozilla/5.0 Smart Stock academic benchmark"}), timeout=25) as reply:
            data = reply.read(30_000_001)
        if len(data) > 30_000_000:
            raise ValueError("The download exceeded the expected dataset size.")
        save_to.write_bytes(data)
    return save_to


def integer(value):
    number = Decimal(value.strip())
    if not number.is_finite() or number != number.to_integral_value():
        raise ValueError("Non-integer movement field.")
    return int(number)


def rows(stream):
    return ({key.strip().lower(): (value or "").strip() for key, value in row.items()} for row in csv.DictReader(stream))


def inventory(movement):
    by_upc = defaultdict(dict)
    duplicates = defaultdict(set)
    with ZipFile(movement) as archive:
        csv_file, = [item for item in archive.infolist() if Path(item.filename).name.lower() == "woat.csv"]
        if csv_file.file_size > 200_000_000:
            raise ValueError("The movement CSV exceeded the expected dataset size.")
        with archive.open(csv_file) as zipped, io.TextIOWrapper(zipped, encoding="latin-1", newline="") as text_file:
            for item in rows(text_file):
                try:
                    if integer(item["store"]) != STORE or integer(item["ok"]) != 1:
                        continue
                    upc, week, qty = (integer(item[key]) for key in ("upc", "week", "move"))
                    if week < 1 or qty < 0:
                        continue
                    if week in by_upc[upc]:
                        duplicates[upc].add(week)
                    by_upc[upc][week] = (qty, item["sale"])
                except (ValueError, InvalidOperation):
                    continue
    return {
        upc: {week: data for week, data in observed.items() if week not in duplicates[upc]}
        for upc, observed in by_upc.items()
    }


def continuous(weeks):
    run = []
    for week in sorted(weeks):
        if run and week != run[-1] + 1:
            yield run
            run = []
        run.append(week)
    if run:
        yield run


def score(actual, forecast):
    errors = [abs(a - b) for a, b in zip(actual, forecast, strict=True)]
    return {
        "mae": round(statistics.mean(errors), 3),
        "rmse": round(math.sqrt(statistics.mean(error * error for error in errors)), 3),
        "wape_pct": round(100 * sum(errors) / sum(actual), 2) if sum(actual) else None,
    }


def week_date(week):
    return WEEK_1 + timedelta(weeks=week - 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    backend = Path(__file__).resolve().parents[1]
    parser.add_argument("--cache", type=Path, default=backend / ".cache/dominicks-oatmeal")
    parser.add_argument("--chronos-model", type=Path)
    args = parser.parse_args()
    folder = args.cache
    folder.mkdir(parents=True, exist_ok=True)
    catalog = downloaded(folder, "upc_csv-files/upcoat.csv")
    movement = downloaded(folder, "movement_csv-files/woat.zip")
    observed = inventory(movement)
    coverage, upc, start, weeks = min(
        ((-len(sequence), upc, sequence[0], sequence)
         for upc, observations in observed.items() for sequence in continuous(observations)),
        key=lambda item: item[:3],
    )
    if -coverage < 104 + HOLDOUT:
        raise ValueError("Selected series lacks a two-year training history and a 26-week evaluation window.")
    with catalog.open(encoding="latin-1", newline="") as source:
        names = {integer(item["upc"]): item["descrip"] for item in rows(source)}
    series = [observed[upc][week][0] for week in weeks]
    predictions = {"4-week average": [], "same week previous year": []}
    for index in range(len(series) - HOLDOUT, len(series)):
        predictions["4-week average"].append(statistics.mean(series[index - 4 : index]))
        predictions["same week previous year"].append(series[index - 52])
    if args.chronos_model is not None:
        import sys

        sys.path.insert(0, str(backend))
        from app.services.forecasting import ForecastEngine

        engine = ForecastEngine()
        engine.load(True, str(args.chronos_model.resolve()), "cpu")
        histories = [series[:index] for index in range(len(series) - HOLDOUT, len(series))]
        batched = engine.chronos_validation(histories)
        if batched is None:
            raise ValueError("Chronos could not evaluate the weekly series.")
        predictions["Chronos-Bolt Small"] = [item[0] for item in batched]
    results = {
        "source": SOURCE, "category": "Oatmeal", "store": STORE, "upc": str(upc),
        "name": names.get(upc, "Unlisted UPC"), "frequency": "weekly", "observations": len(weeks),
        "first_week": str(week_date(start)), "last_week": str(week_date(weeks[-1])),
        "holdout_start": str(week_date(weeks[-HOLDOUT])), "holdout_end": str(week_date(weeks[-1]) + timedelta(days=6)),
        "holdout_observations": HOLDOUT, "holdout_units": sum(series[-HOLDOUT:]),
        "holdout_promotion_flagged_weeks": sum(bool(observed[upc][week][1]) for week in weeks[-HOLDOUT:]),
        "selection": "Longest consecutive valid weekly run at Store 2, with numeric UPC and earliest week used to break ties.",
        "results": {name: score(series[-HOLDOUT:], forecast) for name, forecast in predictions.items()},
        "sha256": {path.name: sha256(path.read_bytes()).hexdigest() for path in (catalog, movement)},
    }
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
