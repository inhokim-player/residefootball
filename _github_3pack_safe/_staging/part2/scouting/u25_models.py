from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PlayerSnapshot:
    player_id: str
    name: str
    photo_url: str
    country: str
    continent: str
    club: str
    league: str
    position: str
    age: int
    height_cm: float
    weight_kg: float
    dominant_foot: str
    physical_index: float
    sprint_speed: float
    distance_per_match_km: float
    minutes_played: int
    pass_attempts: int
    pass_success_rate: float
    pass_miss: int
    duel_win_rate: float
    duel_successes: int
    shot_attempts: int
    shot_accuracy: float
    goals: int
    assists: int
    ball_recoveries: int
    tackle_success_rate: float
    intercept_success_rate: float
    after80_pass_success_rate: float
    after80_attack_success_rate: float
    after80_goals: int
    after80_assists: int
    space_creation_count: int
    dribble_success_rate: float
    dribble_success_count: int
    injuries_count: int


@dataclass(frozen=True)
class ScoutingScore:
    player_id: str
    league: str
    position: str
    performance_score: float
    potential_score: float
    adaptation_probability: float
    total_rank_score: float
