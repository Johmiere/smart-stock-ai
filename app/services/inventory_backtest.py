"""Reproducible, held-out inventory simulation with synthetic latent demand."""
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from math import ceil
from random import Random
from statistics import mean, median


SEED = 4107
TRAIN_DAYS = 56
TEST_DAYS = 84
HOLDING_RATE = Decimal("0.08")
SKUS = [
    ("3-in-1 coffee", 8, 45, 29, 35),
    ("Fresh bread", 5, 42, 27, 5),
    ("Slow-moving canned goods", 2, 65, 47, 75),
]


def generate(rate, sku, promo_pct):
    rng = Random(SEED + sku)
    days = []
    for index in range(-TRAIN_DAYS, TEST_DAYS):
        day = date(2025, 1, 1) + timedelta(days=index)
        promo = index in {24, 25, 26, 52, 53, 54}
        baseline = rate * (1.28 if day.weekday() in {5, 6} else 1)
        baseline *= 1.20 if day.day in {15, 30, 31} else 1
        if sku == 0 and promo:
            baseline *= 1 + promo_pct / 100
        if sku == 1 and index >= 45:
            baseline *= 1.35
        intermittent_zero = sku == 2 and rng.random() < .58
        demand = 0 if intermittent_zero else max(0, round(baseline + rng.uniform(-2.2, 2.2)))
        lead = rng.choice((2, 3, 3, 4, 6))
        capacity = max(0, rate // 2) if index < 0 and index % 11 in {1, 2} else demand + 1
        days.append({"demand": demand, "lead": lead, "promo": promo and sku == 0,
                     "training_sales": min(demand, capacity), "training_censored": capacity <= demand})
    return days[:TRAIN_DAYS], days[TRAIN_DAYS:]


def simulate(training, future, price, unit_cost, shelf_life, policy, promo_pct):
    training_values = [day["training_sales"] for day in training]
    observed = [(day["training_sales"], day["training_censored"], False) for day in training]
    observed_lead = [day["lead"] for day in training]
    base = mean(training_values)
    batches = [(shelf_life, ceil(base * 5))]
    arrivals = defaultdict(list)
    ordered = expired = missed = holding_units = stockout_days = sales = 0
    forecast_error = forecast_total = 0

    for today, day in enumerate(future):
        for qty, lead in arrivals.pop(today, []):
            batches.append((today + shelf_life, qty))
            observed_lead.append(lead)
        expired += sum(qty for expiry, qty in batches if expiry <= today)
        batches = sorted((expiry, qty) for expiry, qty in batches if expiry > today and qty)
        stock = sum(qty for _, qty in batches)
        incoming = sum(qty for orders in arrivals.values() for qty, _ in orders)
        if policy == "fixed":
            daily = base
            threshold = ceil(base * 3)
            target = ceil(base * 7)
        else:
            observations = [sold for sold, censored, promo_day in observed[-42:] if not censored and not promo_day]
            daily = mean(observations) if observations else mean(sold for sold, _, _ in observed[-14:])
            lead_values = sorted(observed_lead[-30:])
            conservative_lead = lead_values[ceil(.9 * len(lead_values)) - 1]
            if policy == "adaptive":
                # The promotion schedule is known in advance. Actual demand and
                # the supplier's next sampled lead time remain hidden.
                promo_days = sum(future[n]["promo"] for n in range(today, min(len(future), today + conservative_lead + 1)))
                promo_lift = daily * promo_days * promo_pct / 100
            else:
                promo_lift = 0
            extra = 1 if shelf_life <= 5 else 2
            threshold = ceil(daily * conservative_lead + promo_lift)
            target = min(ceil(daily * (conservative_lead + extra) + promo_lift), ceil(daily * shelf_life * 1.2))
        inventory_position = stock + incoming
        if inventory_position <= threshold and (policy != "fixed" or today % 3 == 0):
            quantity = max(0, target - inventory_position)
            if quantity:
                arrivals[today + day["lead"]].append((quantity, day["lead"]))
                ordered += quantity
        prediction = daily * (1 + promo_pct / 100) if policy == "adaptive" and day["promo"] else daily
        demand = day["demand"]
        forecast_error += abs(demand - prediction)
        forecast_total += demand
        served = min(stock, demand)
        sales += served
        missed += demand - served
        stockout_days += demand > served
        observed.append((served, stock <= demand and stock > 0 or stock == 0, day["promo"]))
        remaining_to_sell = served
        carry = []
        for expiry, qty in batches:
            take = min(remaining_to_sell, qty)
            remaining_to_sell -= take
            if qty > take:
                carry.append((expiry, qty - take))
        batches = carry
        holding_units += stock - served
    waste_cost = Decimal(expired * unit_cost)
    stockout_cost = Decimal(missed * (price - unit_cost))
    holding_cost = HOLDING_RATE * holding_units
    return {
        "units_sold": sales, "stockout_days": stockout_days, "unmet_units": missed,
        "expired_units": expired, "ordered_units": ordered, "holding_unit_days": holding_units,
        "waste_cost": float(waste_cost), "holding_cost": float(holding_cost),
        "missed_margin": float(stockout_cost), "total_cost": float(waste_cost + holding_cost + stockout_cost),
        "wape": round(100 * forecast_error / forecast_total, 2) if forecast_total else None,
    }


def compare(promo_pct):
    rows = []
    censored = zeros = 0
    for index, (name, rate, price, cost, shelf) in enumerate(SKUS):
        training, future = generate(rate, index, promo_pct)
        censored += sum(day["training_censored"] for day in training)
        zeros += sum(day["training_sales"] == 0 for day in training)
        for key, label in (
            ("fixed", "Fixed reorder"), ("adaptive", "Adaptive reorder"),
            ("without_promo", "Adaptive without promo context"),
        ):
            result = simulate(training, future, price, cost, shelf, key, promo_pct)
            rows.append({"sku": name, "policy": label, **result})
    totals = {
        label: {field: round(sum(row[field] for row in rows if row["policy"] == label), 2) for field in
                ("stockout_days", "unmet_units", "expired_units", "waste_cost", "holding_cost", "missed_margin", "total_cost")}
        for label in ("Fixed reorder", "Adaptive reorder", "Adaptive without promo context")
    }
    return {
        "seed": SEED, "training_days": TRAIN_DAYS, "test_days": TEST_DAYS, "sku_count": len(SKUS),
        "training_censored_days": censored, "training_zero_sales_days": zeros, "promo_pct": promo_pct,
        "rows": rows, "totals": totals,
        "modeled_savings": round(totals["Fixed reorder"]["total_cost"] - totals["Adaptive reorder"]["total_cost"], 2),
    }
