from __future__ import annotations

import math
from collections import defaultdict
from statistics import mean, pstdev
from typing import Any

from scouting.u25_models import PlayerSnapshot

LEAGUE_INTENSITY: dict[str, float] = {
    "Premier League": 1.0,
    "La Liga": 0.93,
    "Serie A": 0.9,
    "Bundesliga": 0.95,
    "Ligue 1": 0.88,
    "Eredivisie": 0.82,
    "Primeira Liga": 0.82,
    "J1 League": 0.78,
    "K League 1": 0.75,
    "MLS": 0.8,
}

POSITION_WEIGHTS: dict[str, dict[str, float]] = {
    "FW": {"finishing": 0.3, "creativity": 0.2, "duel": 0.15, "speed": 0.2, "late": 0.15},
    "MF": {"finishing": 0.15, "creativity": 0.35, "duel": 0.15, "speed": 0.15, "late": 0.2},
    "DF": {"finishing": 0.05, "creativity": 0.2, "duel": 0.3, "speed": 0.15, "late": 0.1, "defense": 0.2},
    "GK": {"duel": 0.35, "late": 0.15, "defense": 0.35, "creativity": 0.15},
}


def _safe_z(value: float, series: list[float]) -> float:
    if not series:
        return 0.0
    sd = pstdev(series)
    if sd == 0:
        return 0.0
    return (value - mean(series)) / sd


def _sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))


def _feature_bundle(p: dict[str, Any]) -> dict[str, float]:
    return {
        "finishing": (p["shot_accuracy"] * 0.45) + (p["goals"] * 0.2) + (p["after80_goals"] * 0.35),
        "creativity": (p["pass_success_rate"] * 0.35)
        + (p["assists"] * 0.25)
        + (p["space_creation_count"] * 0.2)
        + (p["dribble_success_rate"] * 0.2),
        "duel": (p["duel_win_rate"] * 0.5) + (p["duel_successes"] * 0.5),
        "speed": (p["sprint_speed"] * 0.5) + (p["distance_per_match_km"] * 2.5),
        "late": (p["after80_pass_success_rate"] * 0.35)
        + (p["after80_attack_success_rate"] * 0.35)
        + (p["after80_assists"] * 0.3),
        "defense": (p["tackle_success_rate"] * 0.4)
        + (p["intercept_success_rate"] * 0.35)
        + (p["ball_recoveries"] * 0.25),
    }


def _position_of(raw_position: str) -> str:
    token = (raw_position or "").upper()
    if token.startswith("GK"):
        return "GK"
    if token.startswith("DF") or token in {"CB", "LB", "RB"}:
        return "DF"
    if token.startswith("MF") or token in {"CM", "CDM", "CAM"}:
        return "MF"
    return "FW"


def _adaptation_probability(player: dict[str, Any], target_league: str) -> float:
    target_intensity = LEAGUE_INTENSITY.get(target_league, 0.82)
    current_intensity = LEAGUE_INTENSITY.get(player["league"], 0.78)
    fit_gap = 1.0 - abs(target_intensity - current_intensity)

    age_curve = max(0.0, 1.0 - abs(player["age"] - 21) / 10.0)
    durability = max(0.0, 1.0 - (player["injuries_count"] / 10.0))
    technique = (player["pass_success_rate"] + player["dribble_success_rate"] + player["shot_accuracy"]) / 300.0
    physical = (player["physical_index"] + (player["sprint_speed"] * 3.0)) / 200.0
    iq = (player["space_creation_count"] / 20.0) + (player["after80_attack_success_rate"] / 100.0)
    score = (
        (technique * 1.1)
        + (physical * 1.0)
        + (age_curve * 0.8)
        + (durability * 0.9)
        + (iq * 0.7)
        + (fit_gap * 1.2)
        - 2.6
    )
    return round(_sigmoid(score) * 100.0, 2)


def build_rankings(players: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not players:
        return []

    by_position: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for p in players:
        by_position[_position_of(p["position"])].append(p)

    rows: list[dict[str, Any]] = []
    for position, group in by_position.items():
        metrics = {
            "pass_success_rate": [x["pass_success_rate"] for x in group],
            "duel_win_rate": [x["duel_win_rate"] for x in group],
            "shot_accuracy": [x["shot_accuracy"] for x in group],
            "minutes_played": [x["minutes_played"] for x in group],
            "distance_per_match_km": [x["distance_per_match_km"] for x in group],
            "space_creation_count": [x["space_creation_count"] for x in group],
            "tackle_success_rate": [x["tackle_success_rate"] for x in group],
            "intercept_success_rate": [x["intercept_success_rate"] for x in group],
        }
        weights = POSITION_WEIGHTS.get(position, POSITION_WEIGHTS["FW"])

        for p in group:
            f = _feature_bundle(p)
            position_sum = 0.0
            for feature_name, w in weights.items():
                position_sum += f.get(feature_name, 0.0) * w

            z_perf = (
                _safe_z(p["pass_success_rate"], metrics["pass_success_rate"])
                + _safe_z(p["duel_win_rate"], metrics["duel_win_rate"])
                + _safe_z(p["shot_accuracy"], metrics["shot_accuracy"])
                + _safe_z(p["space_creation_count"], metrics["space_creation_count"])
            )

            potential = (
                (100 - (p["age"] - 18) * 6.5)
                + (p["sprint_speed"] * 1.5)
                + (p["physical_index"] * 0.8)
                + (p["minutes_played"] / 80.0)
                - (p["injuries_count"] * 3.5)
            )
            potential_score = max(0.0, min(100.0, potential))

            performance_score = max(0.0, min(100.0, (position_sum * 0.45) + ((z_perf + 3) * 10)))
            adaptation_prob = _adaptation_probability(p, p["league"])

            total = (performance_score * 0.45) + (potential_score * 0.35) + (adaptation_prob * 0.20)
            rows.append(
                {
                    "player_id": p["player_id"],
                    "league": p["league"],
                    "position": position,
                    "performance_score": round(performance_score, 2),
                    "potential_score": round(potential_score, 2),
                    "adaptation_probability": round(adaptation_prob, 2),
                    "total_rank_score": round(total, 2),
                }
            )
    return sorted(rows, key=lambda x: x["total_rank_score"], reverse=True)


def league_adaptation_matrix(player: dict[str, Any]) -> list[dict[str, float | str]]:
    rows: list[dict[str, float | str]] = []
    for league in sorted(LEAGUE_INTENSITY.keys()):
        rows.append(
            {
                "league": league,
                "adaptation_probability": _adaptation_probability(player, league),
            }
        )
    rows.sort(key=lambda x: float(x["adaptation_probability"]), reverse=True)
    return rows
