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


# --------------------------------------------------------------------------
# Hotel & hostel pricing
# --------------------------------------------------------------------------
PRODUCTS = ("skin", "skinless", "liver", "live")
# The three meat products draw from the meat pool. 'live' is a whole bird
# leaving the shed, so it draws from the BIRD stock instead — different
# balance, different market rate.
MEAT_PRODUCTS = ("skin", "skinless", "liver")
MARKET_KEY = {"skin": "rateSkin", "skinless": "rateSkinless",
              "liver": "rateLiver", "live": "rateLive"}
PRODUCT_LABEL = {"skin": "skin", "skinless": "skinless",
                 "liver": "liver", "live": "live bird"}


def price_hotel_line(line: dict, entry: dict) -> dict:
    """
    Work out what one hotel/hostel line is worth.

    The market rate is whatever the shop is charging at the counter that day
    (Section C of the entry). The hotel's own rate is that market rate less the
    agreed concession — so if skin is ₹250 today and this hotel is on ₹50 less,
    they are billed ₹200. That concession can also be negative, which flips it
    into a premium: -20 bills ₹270, above the counter. A fixed-rate customer
    ignores the market entirely, and a one-off override beats both. The gap
    between the market rate and what they actually pay is reported signed —
    positive is a concession given away, negative is a premium earned — rather
    than clamped to hide which way it went.
    """
    product = line.get("product") if line.get("product") in PRODUCTS else "skin"
    market = _d(entry.get(MARKET_KEY[product]))

    override = line.get("rateOverride")
    if override not in (None, ""):
        rate = _d(override)
    elif line.get("mode") == "fixed":
        rate = _d(line.get("fixed"))
    else:
        rate = market - _d(line.get("less"))
    if rate < D0:
        rate = D0

    grams = int(line.get("weightG") or 0)
    kg = _d(grams) / Decimal(1000)
    amount = kg * rate
    concession = kg * (market - rate)

    return {"product": product, "grams": grams, "market": market, "rate": rate,
            "amount": amount, "concession": concession,
            "birds": int(line.get("birds") or 0) if product == "live" else 0,
            "settled": bool(line.get("settled")),
            "customerId": line.get("customerId") or "",
            "customerName": line.get("customerName") or ""}


def compute_entry(entry: dict, settings: dict, labour: dict | None = None) -> dict:
    """
    `entry` is the dict form of a DailyEntry (see DailyEntry.to_dict).
    `labour` is {'wages': x, 'other': y, 'manDays': z} for that branch and day.
    """
    labour = labour or {"wages": 0, "advances": 0, "other": 0,
                        "overheads": 0, "manDays": 0}

    waste_pct = waste_pct_for(entry.get("category"), settings)
    exp_yield = Decimal(100) - waste_pct
    yield_frac = exp_yield / Decimal(100)
    tol = _d(settings.get("tolerance", 2))

    # ---- purchases and weighted average cost ----------------------------
    buy_birds = 0
    buy_wt_g = 0
    buy_amt = D0
    for p in entry.get("purchases", []) or []:
        # Birds returned to a supplier are a supplier-ledger event only — they
        # do not add to this day's available stock, so they're skipped here.
        # See the Purchase model docstring and the /api/purchase-ledger route.
        if p.get("kind") == "return":
            continue
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
    counter_sale_amt = skin_amt + skinless_amt + liver_amt

    # ---- hotel & hostel sales -------------------------------------------
    # These are sales in addition to the counter figures above, so their
    # weight comes out of the same meat pool and their money goes into the
    # same revenue line — just at a contracted price rather than the
    # over-the-counter one.
    hotel_lines = [price_hotel_line(l, entry) for l in (entry.get("hotelSales") or [])]
    hotel_g = {"skin": 0, "skinless": 0, "liver": 0, "live": 0}
    hotel_amt = D0
    hotel_conc = D0
    hotel_cash = D0
    hotel_credit = D0
    hotel_birds = 0
    for h in hotel_lines:
        hotel_g[h["product"]] += h["grams"]
        hotel_birds += h["birds"]
        hotel_amt += h["amount"]
        hotel_conc += h["concession"]
        if h["settled"]:
            hotel_cash += h["amount"]
        else:
            hotel_credit += h["amount"]
    # meat that left the pool vs live birds that left the shed
    hotel_meat_g = hotel_g["skin"] + hotel_g["skinless"] + hotel_g["liver"]
    hotel_live_g = hotel_g["live"]
    hotel_total_g = hotel_meat_g + hotel_live_g

    meat_sale_amt = counter_sale_amt + hotel_amt
    revenue = meat_sale_amt + live_amt + cut_amt

    # ---- bird & meat balance --------------------------------------------
    handled = int(entry.get("openBirds") or 0) + buy_birds
    # a live bird sold to a hotel or a function leaves the shed exactly like a
    # counter live sale, so it comes off the bird count and the bird weight
    #
    # Unlike opening MEAT (see exp_close_meat_g_raw below), opening BIRDS
    # legitimately belongs in this sum — a live bird sitting in the shed
    # from yesterday and one bought this morning are the same kind of stock,
    # not two different-provenance pools being mixed. What still needs
    # guarding against is the same failure mode as meat: more recorded as
    # sold/dressed/dead than were actually on hand, which must show up as a
    # same-day deficit rather than a negative headcount that compounds into
    # tomorrow's opening count.
    exp_birds_raw = (handled - int(entry.get("liveSoldCount") or 0) - hotel_birds
                     - int(entry.get("mortCount") or 0) - int(entry.get("dressedCount") or 0))
    bird_deficit = max(-exp_birds_raw, 0)
    exp_birds = max(exp_birds_raw, 0)
    bird_var = exp_birds - int(entry.get("closeBirds") or 0)
    mort_rate = (_d(entry.get("mortCount") or 0) / _d(handled) * 100) if handled > 0 else D0

    exp_close_wt_g_raw = (avail_wt_g - int(entry.get("liveSoldWtG") or 0) - hotel_live_g
                          - int(entry.get("mortWtG") or 0) - dressed_wt_g)
    wt_deficit_g = max(-exp_close_wt_g_raw, 0)
    exp_close_wt_g = max(exp_close_wt_g_raw, 0)

    meat_avail_g = int(entry.get("openMeatG") or 0) + actual_meat_g
    # Closing meat — the figure that becomes tomorrow's opening meat — is
    # deliberately built from TODAY's dressing only (actual meat obtained,
    # less whatever left the pool today). Opening meat is still reported
    # (meatAvailG, openMeatValue, and the P&L cost basis below) but is not
    # folded into what carries forward. That makes every day's carry-forward
    # self-contained: a bad or uncounted day can no longer cascade into a
    # running negative balance down the chain, which is exactly what
    # happened at Yarrakatta.
    # liver draws from the same meat pool as skin and skinless, and so does
    # everything that went out to a hotel or hostel
    exp_close_meat_g_raw = (actual_meat_g - int(entry.get("skinSoldG") or 0)
                            - int(entry.get("skinlessSoldG") or 0)
                            - int(entry.get("liverSoldG") or 0)
                            - hotel_meat_g
                            - int(entry.get("damageG") or 0))
    # Physical stock can never be negative — a negative result here means
    # more was recorded as sold/gone today than was actually dressed today
    # (a data-entry slip, or genuinely oversold). Floor it, and keep the
    # clamped-away amount as its own reported figure (meatDeficitG) so the
    # shortfall stays visible to admin rather than silently vanishing.
    meat_deficit_g = max(-exp_close_meat_g_raw, 0)
    exp_close_meat_g = max(exp_close_meat_g_raw, 0)
    meat_var_g = exp_close_meat_g - int(entry.get("closeMeatG") or 0)

    # ---- profit & loss (daily; overheads are handled separately) --------
    open_meat_value = _d(entry.get("openMeatG") or 0) / Decimal(1000) * meat_cost_kg
    close_live_value = _d(entry.get("closeWtG") or 0) / Decimal(1000) * avg_rate
    close_meat_value = _d(entry.get("closeMeatG") or 0) / Decimal(1000) * meat_cost_kg
    close_value = close_live_value + close_meat_value
    cogs = (avail_value + open_meat_value) - close_value
    gross_profit = revenue - cogs

    wages = _d(labour.get("wages"))
    advances = _d(labour.get("advances"))
    other_exp = _d(labour.get("other"))
    overheads = _d(labour.get("overheads"))
    # Wages, shop extras and this day's share of the monthly overheads are all
    # real costs. An advance is cash moving against wages already counted, so
    # it is reported for visibility but never deducted again.
    net_profit = gross_profit - wages - other_exp - overheads

    # ---- loss drivers ----------------------------------------------------
    mort_value = _d(entry.get("mortWtG") or 0) / Decimal(1000) * avg_rate
    damage_value = _d(entry.get("damageG") or 0) / Decimal(1000) * meat_cost_kg
    short_value = _d(short_g) / Decimal(1000) * meat_cost_kg
    bonus_value = _d(bonus_g) / Decimal(1000) * meat_cost_kg
    meat_deficit_value = _d(meat_deficit_g) / Decimal(1000) * meat_cost_kg
    wt_deficit_value = _d(wt_deficit_g) / Decimal(1000) * avg_rate

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
        "counterSaleAmt": money(counter_sale_amt),
        "meatSaleAmt": money(meat_sale_amt), "revenue": money(revenue),
        # hotels & hostels
        "hotelAmt": money(hotel_amt), "hotelConcession": money(hotel_conc),
        "hotelCash": money(hotel_cash), "hotelCredit": money(hotel_credit),
        "hotelSkinG": hotel_g["skin"], "hotelSkinlessG": hotel_g["skinless"],
        "hotelLiverG": hotel_g["liver"], "hotelLiveG": hotel_g["live"],
        "hotelMeatG": hotel_meat_g, "hotelTotalG": hotel_total_g,
        "hotelBirds": hotel_birds,
        "hotelCount": len([h for h in hotel_lines if h["grams"] > 0]),
        "hotelLines": [{"customerId": h["customerId"], "customerName": h["customerName"],
                        "product": h["product"], "weightG": h["grams"],
                        "birds": h["birds"],
                        "marketRate": money(h["market"]), "rate": money(h["rate"]),
                        "amount": money(h["amount"]), "concession": money(h["concession"]),
                        "settled": h["settled"]} for h in hotel_lines],
        # what should have come into the till today: everything sold for cash
        # here, with credit sales left out because no money changed hands
        "cashSales": money(counter_sale_amt + live_amt + cut_amt + hotel_cash),
        "handled": handled, "expBirds": exp_birds, "birdVar": bird_var,
        "birdDeficit": bird_deficit,
        "mortRate": float(round(mort_rate, 2)),
        "expCloseWtG": exp_close_wt_g, "meatAvailG": meat_avail_g,
        "wtDeficitG": wt_deficit_g, "wtDeficitValue": money(wt_deficit_value),
        "expCloseMeatG": exp_close_meat_g, "meatVarG": meat_var_g,
        "meatDeficitG": meat_deficit_g, "meatDeficitValue": money(meat_deficit_value),
        "openMeatValue": money(open_meat_value), "closeValue": money(close_value),
        "cogs": money(cogs), "grossProfit": money(gross_profit),
        "labour": money(wages), "advances": money(advances),
        "otherExp": money(other_exp), "overheads": money(overheads),
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

    for i, h in enumerate(entry.get("hotelSales") or [], start=1):
        grams = int(h.get("weightG") or 0)
        if grams > 0 and not h.get("customerId"):
            missing.append(f"Hotel/hostel line {i} — choose the hotel or hostel")
        if h.get("customerId") and grams <= 0:
            missing.append(f"Hotel/hostel line {i} — enter the weight sold")
        if grams > 0:
            priced = price_hotel_line(h, entry)
            if priced["rate"] <= 0:
                missing.append(
                    f"Hotel/hostel line {i} — the price works out to ₹0. "
                    f"Set the {PRODUCT_LABEL[priced['product']]} rate in Section C, "
                    f"or give this customer a fixed rate.")
            # a live sale has to say how many birds went, or the bird count
            # will not balance at closing
            if priced["product"] == "live" and priced["birds"] <= 0:
                missing.append(f"Hotel/hostel line {i} — how many live birds were sold?")

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
