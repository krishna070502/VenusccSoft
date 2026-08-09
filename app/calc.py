"""
Server-side calculation engine.

This is the authoritative version of the maths. The browser mirrors it for
instant feedback while typing, but every figure that reaches a report, an
approval screen or the profit dashboard is recomputed here so a tampered
client cannot change what the business sees.

Weights are integer grams throughout; money is Decimal.
"""

from decimal import Decimal, ROUND_HALF_UP
from datetime import date

D0 = Decimal("0")


def _d(x) -> Decimal:
    if isinstance(x, Decimal):
        return x
    return Decimal(str(x or 0))


def money(x) -> float:
    return float(_d(x).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def waste_pct_for(category: str, settings: dict) -> Decimal:
    key = "waste_parents" if category == "parents" else "waste_broiler"
    return _d(settings.get(key, 21 if category == "parents" else 31))


def compute_entry(entry: dict, settings: dict, labour: dict | None = None) -> dict:
    """
    `entry` is the dict form of a DailyEntry (see DailyEntry.to_dict).
    `labour` is {'wages': x, 'other': y, 'manDays': z} for that branch and day.
    """
    labour = labour or {"wages": 0, "other": 0, "manDays": 0}

    waste_pct = waste_pct_for(entry.get("category"), settings)
    exp_yield = Decimal(100) - waste_pct
    yield_frac = exp_yield / Decimal(100)
    tol = _d(settings.get("tolerance", 2))

    # ---- purchases and weighted average cost ----------------------------
    buy_birds = 0
    buy_wt_g = 0
    buy_amt = D0
    for p in entry.get("purchases", []) or []:
        buy_birds += int(p.get("birds") or 0)
        buy_wt_g += int(p.get("wtG") or 0)
        buy_amt += _d(p.get("wtG") or 0) / Decimal(1000) * _d(p.get("rate") or 0)

    open_wt_g = int(entry.get("openWtG") or 0)
    open_rate = _d(entry.get("openRate"))
    open_value = _d(open_wt_g) / Decimal(1000) * open_rate

    avail_wt_g = open_wt_g + buy_wt_g
    avail_value = open_value + buy_amt
    avg_rate = (avail_value / (_d(avail_wt_g) / Decimal(1000))) if avail_wt_g > 0 else open_rate
    meat_cost_kg = (avg_rate / yield_frac) if yield_frac > 0 else D0

    # ---- dressing --------------------------------------------------------
    dressed_wt_g = int(entry.get("dressedWtG") or 0)
    actual_meat_g = int(entry.get("actualMeatG") or 0)
    expected_meat_g = int(_d(dressed_wt_g) * yield_frac)
    waste_meat_g = dressed_wt_g - expected_meat_g
    variance_g = actual_meat_g - expected_meat_g
    bonus_g = max(variance_g, 0)
    short_g = max(-variance_g, 0)
    yield_pct = (_d(actual_meat_g) / _d(dressed_wt_g) * 100) if dressed_wt_g > 0 else D0
    yield_low = dressed_wt_g > 0 and actual_meat_g > 0 and yield_pct < (exp_yield - tol)
    yield_high = dressed_wt_g > 0 and yield_pct > (exp_yield + tol)

    # ---- revenue ---------------------------------------------------------
    def sale(grams_key, rate_key):
        return _d(entry.get(grams_key) or 0) / Decimal(1000) * _d(entry.get(rate_key) or 0)

    skin_amt = sale("skinSoldG", "rateSkin")
    skinless_amt = sale("skinlessSoldG", "rateSkinless")
    liver_amt = sale("liverSoldG", "rateLiver")
    live_amt = sale("liveSoldWtG", "rateLive")
    cut_amt = _d(entry.get("cutCharges"))
    meat_sale_amt = skin_amt + skinless_amt + liver_amt
    revenue = meat_sale_amt + live_amt + cut_amt

    # ---- bird & meat balance --------------------------------------------
    handled = int(entry.get("openBirds") or 0) + buy_birds
    exp_birds = (handled - int(entry.get("liveSoldCount") or 0)
                 - int(entry.get("mortCount") or 0) - int(entry.get("dressedCount") or 0))
    bird_var = exp_birds - int(entry.get("closeBirds") or 0)
    mort_rate = (_d(entry.get("mortCount") or 0) / _d(handled) * 100) if handled > 0 else D0

    exp_close_wt_g = (avail_wt_g - int(entry.get("liveSoldWtG") or 0)
                      - int(entry.get("mortWtG") or 0) - dressed_wt_g)

    meat_avail_g = int(entry.get("openMeatG") or 0) + actual_meat_g
    # liver draws from the same meat pool as skin and skinless
    exp_close_meat_g = (meat_avail_g - int(entry.get("skinSoldG") or 0)
                        - int(entry.get("skinlessSoldG") or 0)
                        - int(entry.get("liverSoldG") or 0)
                        - int(entry.get("damageG") or 0))
    meat_var_g = exp_close_meat_g - int(entry.get("closeMeatG") or 0)

    # ---- profit & loss (daily; overheads are handled separately) --------
    open_meat_value = _d(entry.get("openMeatG") or 0) / Decimal(1000) * meat_cost_kg
    close_live_value = _d(entry.get("closeWtG") or 0) / Decimal(1000) * avg_rate
    close_meat_value = _d(entry.get("closeMeatG") or 0) / Decimal(1000) * meat_cost_kg
    close_value = close_live_value + close_meat_value
    cogs = (avail_value + open_meat_value) - close_value
    gross_profit = revenue - cogs

    wages = _d(labour.get("wages"))
    other_exp = _d(labour.get("other"))
    net_profit = gross_profit - wages - other_exp

    # ---- loss drivers ----------------------------------------------------
    mort_value = _d(entry.get("mortWtG") or 0) / Decimal(1000) * avg_rate
    damage_value = _d(entry.get("damageG") or 0) / Decimal(1000) * meat_cost_kg
    short_value = _d(short_g) / Decimal(1000) * meat_cost_kg
    bonus_value = _d(bonus_g) / Decimal(1000) * meat_cost_kg

    photos = entry.get("photos") or []
    needs_photo = int(entry.get("mortCount") or 0) > 0 and len(photos) == 0

    return {
        "wastePct": float(waste_pct), "expYield": float(exp_yield),
        "buyBirds": buy_birds, "buyWtG": buy_wt_g, "buyAmt": money(buy_amt),
        "openValue": money(open_value), "availWtG": avail_wt_g,
        "availValue": money(avail_value), "avgRate": money(avg_rate),
        "meatCostKg": money(meat_cost_kg),
        "expectedMeatG": expected_meat_g, "wasteMeatG": waste_meat_g,
        "varianceG": variance_g, "bonusG": bonus_g, "shortG": short_g,
        "yieldPct": float(round(yield_pct, 2)), "yieldLow": yield_low, "yieldHigh": yield_high,
        "skinAmt": money(skin_amt), "skinlessAmt": money(skinless_amt),
        "liverAmt": money(liver_amt), "liveAmt": money(live_amt), "cutAmt": money(cut_amt),
        "meatSaleAmt": money(meat_sale_amt), "revenue": money(revenue),
        "handled": handled, "expBirds": exp_birds, "birdVar": bird_var,
        "mortRate": float(round(mort_rate, 2)),
        "expCloseWtG": exp_close_wt_g, "meatAvailG": meat_avail_g,
        "expCloseMeatG": exp_close_meat_g, "meatVarG": meat_var_g,
        "openMeatValue": money(open_meat_value), "closeValue": money(close_value),
        "cogs": money(cogs), "grossProfit": money(gross_profit),
        "labour": money(wages), "otherExp": money(other_exp),
        "manDays": float(labour.get("manDays") or 0),
        "netProfit": money(net_profit),
        "mortValue": money(mort_value), "damageValue": money(damage_value),
        "shortValue": money(short_value), "bonusValue": money(bonus_value),
        "needsPhoto": needs_photo,
    }


# --------------------------------------------------------------------------
# Validation shared by the API and the UI
# --------------------------------------------------------------------------
REQUIRED_FIELDS = [
    ("businessDate", "Date", lambda e: bool(e.get("businessDate")), False),
    ("openBirds", "Opening birds", lambda e: e.get("openBirds") is not None, True),
    ("openWtG", "Opening bird weight", lambda e: int(e.get("openWtG") or 0) > 0, True),
    ("rateSkin", "Skin rate", lambda e: float(e.get("rateSkin") or 0) > 0, False),
    ("rateSkinless", "Skinless rate", lambda e: float(e.get("rateSkinless") or 0) > 0, False),
    ("rateLive", "Live bird price", lambda e: float(e.get("rateLive") or 0) > 0, False),
    ("dressedCount", "Number of dressed birds",
     lambda e: e.get("dressedCount") is not None, False),
    ("dressedWtG", "Live weight of dressed birds",
     lambda e: int(e.get("dressedCount") or 0) == 0 or int(e.get("dressedWtG") or 0) > 0, False),
    ("actualMeatG", "Actual meat obtained",
     lambda e: int(e.get("dressedCount") or 0) == 0 or int(e.get("actualMeatG") or 0) > 0, False),
    ("closeBirds", "Closing birds", lambda e: e.get("closeBirds") is not None, False),
    ("closeWtG", "Closing bird weight",
     lambda e: int(e.get("closeBirds") or 0) == 0 or int(e.get("closeWtG") or 0) > 0, True),
]


def validate_for_submission(entry: dict, is_admin: bool, is_first_entry: bool) -> list[str]:
    """Returns a list of human-readable problems; empty means it may be submitted."""
    missing = []
    for _key, label, test, first_day_optional in REQUIRED_FIELDS:
        if is_first_entry and first_day_optional:
            continue
        try:
            if not test(entry):
                missing.append(label)
        except (TypeError, ValueError):
            missing.append(label)

    for i, p in enumerate(entry.get("purchases") or [], start=1):
        birds = int(p.get("birds") or 0)
        wt = int(p.get("wtG") or 0)
        # the buying rate belongs to the admin, entered at approval time
        if is_admin and (birds > 0 or wt > 0) and float(p.get("rate") or 0) <= 0:
            missing.append(f"Purchase line {i} — rate per kg")
        if birds > 0 and wt <= 0:
            missing.append(f"Purchase line {i} — weight")

    if int(entry.get("mortCount") or 0) > 0 and not (entry.get("photos") or []):
        missing.append("Mortality photo (mortality is above zero)")

    return missing


def costing_gaps(entry: dict) -> list[str]:
    """Buying prices the admin must supply before an entry can be approved."""
    gaps = []
    for i, p in enumerate(entry.get("purchases") or [], start=1):
        if (int(p.get("birds") or 0) > 0 or int(p.get("wtG") or 0) > 0) \
                and float(p.get("rate") or 0) <= 0:
            gaps.append(f"purchase line {i} rate")
    if int(entry.get("openWtG") or 0) > 0 and float(entry.get("openRate") or 0) <= 0:
        gaps.append("opening cost rate")
    return gaps


def months_in_range(from_date: date, to_date: date) -> list[str]:
    out, y, m = [], from_date.year, from_date.month
    guard = 0
    while (y < to_date.year or (y == to_date.year and m <= to_date.month)) and guard < 180:
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
        guard += 1
    return out
