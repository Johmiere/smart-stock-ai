from __future__ import annotations

import logging
from datetime import date, timedelta
from functools import lru_cache
from math import sqrt
from pathlib import Path
from statistics import linear_regression, mean
from threading import Lock
from typing import Any

logger = logging.getLogger(__name__)

MOVING_AVERAGE_WINDOW = 28
REGRESSION_WINDOW = 84
VALIDATION_WEEK = 7
MAX_VALIDATION_WEEKS = 4
RECOMMENDATION_HORIZON = 30
MAX_FORECAST_DAYS = 60
CHRONOS_MIN_HISTORY = 28
MIN_EVALUATION_HISTORY = CHRONOS_MIN_HISTORY + VALIDATION_WEEK


def _moving_average(history: list[float], horizon: int) -> list[float]:
    return [mean(history[-MOVING_AVERAGE_WINDOW:])] * horizon


def _weekly_naive(history: list[float], horizon: int) -> list[float]:
    recent_week = history[-VALIDATION_WEEK:]
    return [recent_week[day % VALIDATION_WEEK] for day in range(horizon)]


def _linear_trend(history: list[float], horizon: int) -> list[float]:
    window = history[-REGRESSION_WINDOW:]
    slope, intercept = linear_regression(range(len(window)), window)
    return [max(0.0, intercept + slope * day) for day in range(len(window), len(window) + horizon)]


def _day_of_week(history: list[float], horizon: int) -> list[float]:
    # Fitting one coefficient per weekday gives the mean for each weekday.
    start = max(0, len(history) - REGRESSION_WINDOW)
    weekday_means = [
        mean(history[start + (weekday - start) % 7::7]) for weekday in range(7)
    ]
    return [weekday_means[(len(history) + day) % 7] for day in range(horizon)]


def recommend_regression(complete_daily_sales: list[float]) -> dict:
    history_days = len(complete_daily_sales)
    minimum_days = MOVING_AVERAGE_WINDOW + VALIDATION_WEEK
    if history_days < minimum_days or sum(units > 0 for units in complete_daily_sales) < 2:
        return {
            "status": "insufficient_history",
            "history_days": history_days,
            "minimum_history_days": minimum_days,
            "message": f"Use at least {minimum_days} complete days of history with sales on at least two days.",
        }

    candidates = {
        "28-day moving average": _moving_average,
        "Linear trend regression": _linear_trend,
        "Day-of-week regression": _day_of_week,
    }
    weeks = min(MAX_VALIDATION_WEEKS, (history_days - MOVING_AVERAGE_WINDOW) // VALIDATION_WEEK)
    validation_days = weeks * VALIDATION_WEEK
    start = history_days - validation_days
    validation_units = sum(complete_daily_sales[start:])
    scores = []
    for method, predict in candidates.items():
        errors = []
        for cutoff in range(start, history_days, VALIDATION_WEEK):
            predicted = predict(complete_daily_sales[:cutoff], VALIDATION_WEEK)
            actual = complete_daily_sales[cutoff:cutoff + VALIDATION_WEEK]
            errors.extend(abs(target - estimate) for target, estimate in zip(actual, predicted))
        scores.append({
            "method": method,
            "mae": mean(errors),
            "rmse": sqrt(mean(error ** 2 for error in errors)),
            "wape_pct": (100 * sum(errors) / validation_units) if validation_units else None,
        })
    scores.sort(key=lambda score: score["mae"])
    best_method = scores[0]["method"]
    next_30_days = sum(candidates[best_method](complete_daily_sales, RECOMMENDATION_HORIZON))
    return {
        "status": "evaluated",
        "recommended_method": best_method,
        "history_days": history_days,
        "validation_days": validation_days,
        "forecast_days": RECOMMENDATION_HORIZON,
        "estimated_units": round(next_30_days, 2),
        "scores": [
            {key: round(value, 2) if isinstance(value, (int, float)) else value for key, value in score.items()}
            for score in scores
        ],
    }


class ForecastEngine:
    def __init__(self) -> None:
        self.pipeline: Any = None
        self.model_error: str | None = None
        self.enabled = False
        self.model_name = "Chronos-Bolt"
        self.device = "cpu"
        self._lock = Lock()
        self._cached_steps = lru_cache(maxsize=256)(self._predict_steps)

    def load(self, enabled: bool, model_id: str, device: str) -> None:
        self.pipeline = None
        self.model_error = None
        self._cached_steps.cache_clear()
        self.enabled = enabled
        self.device = device
        model_id = model_id.strip()
        model_path = Path(model_id).expanduser()
        self.model_name = model_path.name if model_path.is_absolute() or model_id.startswith("models/") else model_id
        if not enabled:
            logger.info("Chronos disabled; moving-average fallback is active.")
            return
        try:
            import torch
            from chronos import BaseChronosPipeline, ChronosBoltPipeline

            # Local model names in .env are relative to the backend, regardless of the launcher cwd.
            local_model = model_path if model_path.is_absolute() else Path(__file__).resolve().parents[2] / model_path
            is_local = local_model.is_dir() or model_path.is_absolute() or model_id.startswith("models/")
            if is_local and not (local_model / "config.json").is_file():
                raise FileNotFoundError("The downloaded model folder lacks config.json.")
            pipeline = BaseChronosPipeline.from_pretrained(
                str(local_model) if is_local else model_id,
                device_map=device,
                torch_dtype=torch.float32,
                local_files_only=is_local,
                use_safetensors=True,
            )
            if not isinstance(pipeline, ChronosBoltPipeline):
                raise ValueError("Set CHRONOS_MODEL to a Chronos-Bolt model.")
            self.pipeline = pipeline
            # A model can load successfully while the inference API or CPU backend is broken.
            # Exercise the same path that serves POS requests before reporting readiness.
            self._predict_steps(tuple(float(day % 7 + 1) for day in range(CHRONOS_MIN_HISTORY)))
            logger.info("Loaded Chronos model %s on %s and verified a forecast", self.model_name, device)
        except ImportError:
            self.pipeline = None
            self.model_error = "Install the Chronos and PyTorch dependencies in the backend Python environment."
            logger.exception("Chronos dependencies could not load.")
        except Exception:
            self.pipeline = None
            self.model_error = "Check the downloaded model folder and configured device, then restart the backend."
            logger.exception("Chronos could not load; fallback forecasts remain available.")

    def readiness(self) -> dict:
        status = "ready" if self.pipeline is not None else "unavailable" if self.enabled else "disabled"
        messages = {
            "ready": "Model loaded and inference verified. Individual items need enough sales history.",
            "unavailable": self.model_error or "Chronos is unavailable. Suitable items use the moving average.",
            "disabled": "Chronos is disabled. Suitable items use the moving average.",
        }
        return {
            "status": status,
            "model": self.model_name,
            "device": self.device,
            "message": messages[status],
            "minimum_history_days": CHRONOS_MIN_HISTORY,
        }

    def _predict_steps(self, sales: tuple[float, ...]) -> tuple[tuple[float, float, float], ...]:
        return self._predict_batch([sales], MAX_FORECAST_DAYS)[0]

    def _predict_batch(
        self, contexts: list[tuple[float, ...]], horizon: int,
    ) -> list[tuple[tuple[float, float, float], ...]]:
        import torch

        inputs = [torch.tensor(sales, dtype=torch.float32) for sales in contexts]
        with self._lock, torch.inference_mode():
            quantiles, _ = self.pipeline.predict_quantiles(
                inputs,
                prediction_length=horizon,
                quantile_levels=[0.1, 0.5, 0.9],
            )
        if tuple(quantiles.shape) != (len(contexts), horizon, 3) or not torch.isfinite(quantiles).all().item():
            raise ValueError("Chronos produced an invalid forecast tensor.")
        # The model can predict negative or slightly crossed quantiles. Demand is
        # nonnegative and the envelope must contain the model's median estimate.
        return [
            tuple(
                (max(0.0, min(low, median)), max(0.0, median), max(0.0, median, high))
                for low, median, high in prediction
            )
            for prediction in quantiles.tolist()
        ]

    def _chronos_steps(self, daily_sales: list[float], horizon: int, *, minimum_days: int = CHRONOS_MIN_HISTORY) -> tuple[tuple[float, float, float], ...] | None:
        if self.pipeline is None or len(daily_sales) < minimum_days:
            return None
        try:
            # Bolt produces a native 64-step block in one pass. Reuse the first
            # 60 steps for the expiry, lead-time and 30-day item views.
            context = tuple(daily_sales[-self.pipeline.model_context_length:])
            return self._cached_steps(context)[:horizon]
        except Exception:
            logger.exception("Chronos inference failed; using the moving-average fallback.")
            return None

    def daily_quantiles(self, daily_sales: list[float], horizon: int):
        if sum(units > 0 for units in daily_sales) < 2:
            return None
        return self._chronos_steps(daily_sales, min(MAX_FORECAST_DAYS, max(1, horizon)), minimum_days=7)

    def chronos_validation(self, histories: list[list[float]]) -> list[list[float]] | None:
        if self.pipeline is None:
            return None
        try:
            context_length = self.pipeline.model_context_length
            contexts = [tuple(history[-context_length:]) for history in histories]
            return [
                [median for _, median, _ in prediction]
                for prediction in self._predict_batch(contexts, VALIDATION_WEEK)
            ]
        except Exception:
            logger.exception("Chronos inference failed for evaluation.")
            return None

    def forecast(self, daily_sales: list[float], horizon: int) -> dict:
        horizon = max(1, min(int(horizon), MAX_FORECAST_DAYS))
        window = daily_sales[-MOVING_AVERAGE_WINDOW:]
        average = max(0.0, mean(window)) if window else 0.0
        sales_days = sum(units > 0 for units in daily_sales)
        steps = self._chronos_steps(daily_sales, horizon) if sales_days >= 2 else None
        if steps is not None:
            low, median, high = (sum(values) for values in zip(*steps))
            return {
                "method": "chronos-bolt",
                "daily_rate": median / horizon,
                "median": median,
                "low": low,
                "high": high,
                "interval_available": True,
            }

        median = average * horizon
        if len(daily_sales) < CHRONOS_MIN_HISTORY or sales_days < 2:
            reason = "insufficient_history"
        elif self.pipeline is not None:
            reason = "inference_failed"
        else:
            reason = self.readiness()["status"]
        return {
            "method": "moving_average_fallback",
            "daily_rate": average,
            "median": median,
            "low": median,
            "high": median,
            "interval_available": False,
            "fallback_reason": reason,
        }


def evaluate_forecasts(engine: ForecastEngine, series: list[float], first_date: date) -> dict:
    history_days = len(series)
    data = {
        "history_days": history_days,
        "minimum_history_days": MIN_EVALUATION_HISTORY,
        "sales_start": first_date.isoformat() if series else None,
        "sales_end": (first_date + timedelta(days=history_days - 1)).isoformat() if series else None,
        "results": [],
        "series": [],
        "folds": [],
        "validation_days": 0,
        "validation_units": 0,
    }
    weeks = max(0, min(MAX_VALIDATION_WEEKS, (history_days - CHRONOS_MIN_HISTORY) // VALIDATION_WEEK))
    cutoffs = [
        i for i in range(history_days - weeks * VALIDATION_WEEK, history_days, VALIDATION_WEEK)
        if sum(units > 0 for units in series[:i]) >= 2
    ]
    if not cutoffs:
        return {
            **data,
            "status": "insufficient_history",
            "message": "Use at least 35 calendar days of recorded history, including sales on two training days before a 7-day holdout.",
        }

    methods = {
        "moving_average": "28-day moving average",
        "weekly_naive": "Prior-week baseline",
        "linear_trend": "Linear trend regression",
        "day_of_week": "Day-of-week regression",
        "chronos": "Chronos-Bolt",
    }
    histories = [series[:i] for i in cutoffs]
    chronos = engine.chronos_validation(histories)
    actuals = []
    estimates = {method: [] for method in methods}
    daily_predictions = []
    folds = []
    for fold_index, (cutoff, history) in enumerate(zip(cutoffs, histories)):
        starting_day = first_date + timedelta(days=cutoff)
        folds.append({
            "train_through": (starting_day - timedelta(days=1)).isoformat(),
            "test_from": starting_day.isoformat(),
            "test_through": (starting_day + timedelta(days=VALIDATION_WEEK - 1)).isoformat(),
        })
        forecasts = {
            "moving_average": _moving_average(history, VALIDATION_WEEK),
            "weekly_naive": _weekly_naive(history, VALIDATION_WEEK),
            "linear_trend": _linear_trend(history, VALIDATION_WEEK),
            "day_of_week": _day_of_week(history, VALIDATION_WEEK),
            "chronos": chronos[fold_index] if chronos is not None else [None] * VALIDATION_WEEK,
        }
        for offset, actual in enumerate(series[cutoff:cutoff + VALIDATION_WEEK]):
            daily = {"date": (starting_day + timedelta(days=offset)).isoformat(), "actual": actual}
            actuals.append(actual)
            for method, values in forecasts.items():
                value = values[offset]
                estimates[method].append(value)
                daily[method] = round(value, 3) if value is not None else None
            daily_predictions.append(daily)

    validation_units = sum(actuals)
    output = []
    scores = {}
    for method, label in methods.items():
        values = estimates[method]
        row = {"method": method, "label": label, "status": "unavailable", "days": 0,
               "mae": None, "rmse": None, "wape_pct": None}
        if any(value is None for value in values):
            row["reason"] = (
                engine.readiness()["message"] if engine.pipeline is None
                else "Chronos inference failed for one or more held-out weeks."
            )
        else:
            errors = [abs(actual - value) for actual, value in zip(actuals, values)]
            scores[method] = mean(errors)
            row.update(
                status="evaluated",
                days=len(errors),
                mae=round(scores[method], 3),
                rmse=round(sqrt(mean(error ** 2 for error in errors)), 3),
                wape_pct=round(100 * sum(errors) / validation_units, 3) if validation_units else None,
            )
        output.append(row)

    return {
        **data,
        "status": "evaluated",
        "validation_days": len(actuals),
        "validation_start": folds[0]["test_from"],
        "validation_end": folds[-1]["test_through"],
        "validation_units": validation_units,
        "recommended_method": min(scores, key=scores.__getitem__),
        "results": output,
        "series": daily_predictions,
        "folds": folds,
        "message": (
            "Methods use identical held-out weeks. Each forecast uses earlier recorded sales only. "
            "Dates without sales records count as zero recorded units. Stockouts or incomplete history "
            "can affect these scores. WAPE is unavailable when actual units total zero."
        ),
    }


def forecast_for_horizon(engine: ForecastEngine, daily_sales: list[float], horizon_days: int) -> dict:
    if horizon_days <= 0:
        return {
            "method": "not_applicable", "median": 0.0, "low": 0.0,
            "high": 0.0, "daily_rate": 0.0, "interval_available": False,
        }
    capped_days = min(horizon_days, MAX_FORECAST_DAYS)
    result = engine.forecast(daily_sales, capped_days)
    if horizon_days > MAX_FORECAST_DAYS:
        extra_days = horizon_days - MAX_FORECAST_DAYS
        extension = result["daily_rate"] * extra_days
        result["median"] += extension
        result["low"] += extension
        result["high"] += extension
        result["extended_beyond_60_days"] = True
    else:
        result["extended_beyond_60_days"] = False
    result["horizon_days"] = horizon_days
    return result


def daily_series(sales_rows: list[dict], start_date: date, end_date: date) -> list[float]:
    totals: dict[date, float] = {}
    for row in sales_rows:
        value = row.get("sale_date")
        if hasattr(value, "date"):
            value = value.date()
        elif isinstance(value, str):
            value = date.fromisoformat(value[:10])
        if value:
            totals[value] = totals.get(value, 0.0) + float(row.get("sale_quantity") or 0)
    result: list[float] = []
    cursor = start_date
    while cursor <= end_date:
        result.append(totals.get(cursor, 0.0))
        cursor += timedelta(days=1)
    return result
