"""
Pricing/access-model resolution shared by all three adapters (Django,
FastAPI, Flask): payment-amount -> access-duration tiers, and per-route
price/duration/tier overrides for a single middleware instance.

Config shapes (plain dicts, so they're trivial to declare in settings.py or
pass as constructor kwargs):

    pricing_tier = {"min_amount": 0.01, "duration_seconds": 3600, "name": "hourly"}
    route_config = {"path_prefix": "/premium", "min_payment": 0.05,
                     "access_duration": None, "pricing_tiers": None}
"""

from __future__ import annotations


def sort_tiers(tiers: list[dict]) -> list[dict]:
    return sorted(tiers, key=lambda t: t["min_amount"])


def resolve_tier(amount_paid: float | None, pricing_tiers: list[dict] | None) -> dict | None:
    """Highest tier whose min_amount the actual paid amount satisfies, or None."""
    if not pricing_tiers or amount_paid is None:
        return None
    matched = None
    for tier in sort_tiers(pricing_tiers):
        if amount_paid >= tier["min_amount"]:
            matched = tier
        else:
            break
    return matched


def normalize_price_config(min_payment: float, access_duration: float | None, pricing_tiers: list[dict] | None) -> dict:
    """Collapses a (min_payment, access_duration, pricing_tiers) config into
    its effective floor price (lowest tier's min_amount when tiers are set)."""
    if pricing_tiers:
        sorted_tiers = sort_tiers(pricing_tiers)
        return {"min_payment": sorted_tiers[0]["min_amount"], "access_duration": None, "pricing_tiers": sorted_tiers}
    return {"min_payment": min_payment, "access_duration": access_duration, "pricing_tiers": None}


def path_matches_prefix(pathname: str, prefix: str) -> bool:
    if pathname == prefix:
        return True
    boundary = prefix if prefix.endswith("/") else prefix + "/"
    return pathname.startswith(boundary)


def build_routes_table(routes: list[dict] | None, min_payment: float, access_duration: float | None, pricing_tiers: list[dict] | None) -> list[dict]:
    """Precomputes normalized route entries once at middleware-construction time."""
    table = []
    for r in routes or []:
        normalized = normalize_price_config(
            r.get("min_payment", min_payment),
            r.get("access_duration", access_duration),
            r.get("pricing_tiers", pricing_tiers),
        )
        table.append({"path_prefix": r["path_prefix"], **normalized})
    return table


def resolve_route_config(pathname: str, routes_table: list[dict], base_config: dict) -> dict:
    """Longest-prefix match against routes_table, falling back to base_config."""
    best = None
    for route in routes_table:
        if path_matches_prefix(pathname, route["path_prefix"]):
            if best is None or len(route["path_prefix"]) > len(best["path_prefix"]):
                best = route
    return best or base_config
