"""Python reference for the normative rules in contracts/CONTRACTS.md.

Why this exists: SPEC A4 says the simulation, verdicts and ranking exist once, in core/ (TypeScript). This
module is NOT a second production implementation. It exists so that (1) make_fixtures.py can write fixtures
that obey the rules, and (2) validate.py can check any run, including runs published by core. core's tests
reproduce the fixture outputs exactly, which is how we catch drift between the two.

Rules for this file: standard library only; plain float arithmetic in the order CONTRACTS.md writes it (no
math.sin/log/exp in anything normative, because libm results can differ between Python and V8 in the last
bit); every function is pure and deterministic.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Iterable, Sequence

DAY_MS = 86_400_000
UINT32 = 0xFFFFFFFF
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

STAGES = ("early", "mid", "late")
STATE_FLOODED, STATE_DRAINED, STATE_UNCERTAIN = "flooded", "drained", "uncertain"
NOTICE = "Ranking for inspection, not a finding about anyone."
K_STAR_RULE = "smallest k with cf false-flag ≤ 0.10"

# Uncertain rule thresholds (SPEC B3.4).
VALID_FRAC_MIN = 0.6
P_DRAINED_MAX = 0.35
P_FLOODED_MIN = 0.65


# ----------------------------------------------------------------------------------------------- PRNG / hash
class Mulberry32:
    """mulberry32, identical to the common JS one-liner using Math.imul (CONTRACTS.md B3.6a)."""

    __slots__ = ("a",)

    def __init__(self, seed: int):
        self.a = seed & UINT32

    def __call__(self) -> float:
        a = (self.a + 0x6D2B79F5) & UINT32
        self.a = a
        t = ((a ^ (a >> 15)) * (a | 1)) & UINT32
        t = ((t + (((t ^ (t >> 7)) * (t | 61)) & UINT32)) & UINT32) ^ t
        return ((t ^ (t >> 14)) & UINT32) / 4294967296


def fnv1a32(text: str) -> int:
    h = 0x811C9DC5
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x01000193) & UINT32
    return h


def derive(seed: int, key: str) -> int:
    return fnv1a32(f"{seed}|{key}")


# ----------------------------------------------------------------------------------------------- time
def parse_ms(value: str) -> int:
    """'YYYY-MM-DD' (00:00Z) or 'YYYY-MM-DDTHH:MM:SSZ' -> integer epoch milliseconds."""
    if len(value) == 10:
        dt = datetime(int(value[0:4]), int(value[5:7]), int(value[8:10]), tzinfo=timezone.utc)
    else:
        if not value.endswith("Z"):
            raise ValueError(f"datetime must end in Z: {value!r}")
        dt = datetime.fromisoformat(value[:-1]).replace(tzinfo=timezone.utc)
    return (dt - EPOCH) // timedelta(milliseconds=1)


def fmt_dt(ms: int) -> str:
    """Integer epoch ms -> 'YYYY-MM-DDTHH:MM:SSZ' (floored to whole seconds)."""
    dt = EPOCH + timedelta(milliseconds=ms - ms % 1000)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def days(value: str) -> float:
    return parse_ms(value) / DAY_MS


def stage_of(datetime_str: str, stages: dict) -> str:
    ms = parse_ms(datetime_str)
    if ms < parse_ms(stages["mid_start"]):
        return "early"
    if ms < parse_ms(stages["late_start"]):
        return "mid"
    return "late"


def in_gap(datetime_str: str, gaps: Iterable[dict]) -> bool:
    ms = parse_ms(datetime_str)
    return any(parse_ms(g["start"]) <= ms <= parse_ms(g["end"]) for g in gaps)


# ----------------------------------------------------------------------------------------------- formatting
def pct(p: float) -> int:
    """Percent shown to people: round half up (CONTRACTS.md C0)."""
    return int((100 * p + 0.5) // 1)


def pct_down(p: float) -> int:
    """Percent rounded down, for probabilities compared against a threshold (CONTRACTS.md B3.5)."""
    return int((100 * p + 1e-9) // 1)


def looks_text(n: int) -> str:
    return "1 clear look" if n == 1 else f"{n} clear looks"


def all_looks_text(n: int) -> str:
    return "the only clear look" if n == 1 else f"all {n} clear looks"


def passes_text(n: int) -> str:
    return "1 pass" if n == 1 else f"{n} passes"


def times_text(k: int) -> str:
    return {1: "once", 2: "twice"}.get(k, f"{k} times")


# ----------------------------------------------------------------------------------------------- uncertain rule
def state_from(p_flooded: float | None, valid_frac: float) -> str:
    if valid_frac < VALID_FRAC_MIN or p_flooded is None or P_DRAINED_MAX < p_flooded < P_FLOODED_MIN:
        return STATE_UNCERTAIN
    return STATE_FLOODED if p_flooded >= P_FLOODED_MIN else STATE_DRAINED


def confidence_from(p_flooded: float | None) -> float | None:
    return None if p_flooded is None else abs(2 * p_flooded - 1)


# ----------------------------------------------------------------------------------------------- simulation
_SIM_MEMO: dict = {}


def simulate(looks: Sequence[tuple[str, str]], params: dict, n_sim: int, seed: int, scenario: str,
             window: tuple[str, str] | None = None) -> list[int]:
    """CONTRACTS.md B3.6a. looks = [(datetime, stage)] sorted ascending. Returns counts, len(looks)+1.

    Memoised on every input (the result is a pure function of them): fields with the same clear looks and
    window share a seed by construction (B3.6a "Seeds"), so a 4,600-field run has a few hundred distinct
    simulations, not 9,200. Keeps `validate.py --recompute` on a real-scale run at seconds, not minutes.
    """
    if scenario not in ("awd", "cf"):
        raise ValueError(scenario)
    memo_key = (tuple((dt, st) for dt, st in looks), json.dumps(params, sort_keys=True), n_sim, seed, scenario,
                None if window is None else tuple(window))
    hit = _SIM_MEMO.get(memo_key)
    if hit is None:
        hit = _SIM_MEMO[memo_key] = _simulate(looks, params, n_sim, seed, scenario, window)
    return list(hit)


def _simulate(looks: Sequence[tuple[str, str]], params: dict, n_sim: int, seed: int, scenario: str,
              window: tuple[str, str] | None) -> list[int]:
    rng = Mulberry32(seed)
    xs = [days(dt) for dt, _ in looks]
    accs = [params["per_pass_accuracy"][stage] for _, stage in looks]
    a0, a1 = params["awd_window_days_after_transplant"]
    c0, c1 = params["cycle_days"]
    f0, f1 = params["drained_fraction_of_cycle"]
    tw0 = days(params["transplant_window"]["start"])
    tw1 = days(params["transplant_window"]["end"])
    q = params["cf_single_drain_prob"]
    fixed = None if window is None else (days(window[0]), days(window[1]))
    is_awd = scenario == "awd"
    counts = [0] * (len(looks) + 1)
    for _ in range(n_sim):
        u_t, u_c, u_f, u_p, u_x = rng(), rng(), rng(), rng(), rng()
        if fixed is None:
            t0 = tw0 + u_t * (tw1 - tw0)
            ws, we = t0 + a0, t0 + a1
        else:
            ws, we = fixed
        cyc = c0 + u_c * (c1 - c0)
        frac_drained = f0 + u_f * (f1 - f0)
        if is_awd:
            phi = u_p * cyc
            threshold = 1 - frac_drained
        else:
            dur = frac_drained * cyc
            start = ws + u_p * ((we - ws) - dur)
            single = u_x < q
        k = 0
        for x, acc in zip(xs, accs):
            u = rng()
            if ws <= x < we:
                if is_awd:
                    y = (x - ws + phi) / cyc
                    truth = (y - (y // 1)) >= threshold
                else:
                    truth = single and start <= x < start + dur
                label = truth if u < acc else not truth
                if label:
                    k += 1
        counts[k] += 1
    return counts


def ge(counts: Sequence[int], k: int) -> float:
    """P(at least k drained labels) = (sum of counts[j] for j >= k) / n_sim, one integer sum then one division."""
    total = sum(counts)
    return sum(counts[k:]) / total if total else 0.0


def k_star_from(cf_counts: Sequence[int], cf_false_flag_max: float) -> int | None:
    """Smallest k in 1..|L| with P(>= k | CF) <= cf_false_flag_max, else None."""
    for k in range(1, len(cf_counts)):
        if ge(cf_counts, k) <= cf_false_flag_max:
            return k
    return None


def detectability(passes: Sequence[dict], params: dict, n_sim: int, seed: int) -> dict:
    """Season-level results from every used pass (each treated as a clear look)."""
    used = sorted((p for p in passes if p["used"]), key=lambda p: parse_ms(p["datetime"]))
    looks = [(p["datetime"], stage_of(p["datetime"], params["stage_boundaries"])) for p in used]
    awd = simulate(looks, params, n_sim, derive(seed, "awd"), "awd")
    cf = simulate(looks, params, n_sim, derive(seed, "cf"), "cf")
    k_star = k_star_from(cf, params["cf_false_flag_max"])
    n = len(looks)
    total = n_sim
    results = {
        "awd": {"p_ge1": ge(awd, 1), "p_ge2": ge(awd, 2), "p_ge3": ge(awd, 3), "dist": [c / total for c in awd]},
        "cf": {"p_ge1_false": ge(cf, 1), "p_ge2_false": ge(cf, 2), "dist": [c / total for c in cf]},
        "k_star": k_star,
        "k_star_rule": K_STAR_RULE,
    }
    return {"pass_dates": [p["datetime"] for p in used], "results": results,
            "sentence": sentence(n, k_star, awd, cf, params["cf_false_flag_max"])}


def sentence(n: int, k_star: int | None, awd_counts, cf_counts, cf_false_flag_max: float) -> str:
    if k_star is not None:
        return (f"With {passes_text(n)}, a field practicing AWD is caught drained at least {times_text(k_star)} "
                f"{pct(ge(awd_counts, k_star))}% of the time; a continuously flooded field shows that "
                f"{pct(ge(cf_counts, k_star))}% of the time.")
    return (f"With {passes_text(n)}, no count of drained looks separates AWD from continuous flooding at a "
            f"{pct(cf_false_flag_max)}% false-flag rate.")


# ----------------------------------------------------------------------------------------------- verdicts
def field_summary(field_id: str, observations: Sequence[dict], pass_by_id: dict, params: dict, stages: dict,
                  n_sim: int, seed: int, run_id: str, fixture: bool | None = None) -> dict:
    """CONTRACTS.md B3.5. observations: this field's lines; pass_by_id: passes.json entries by pass_id."""
    looks = []  # (ms, datetime, stage, state) for clear looks on used passes
    for o in observations:
        p = pass_by_id[o["pass_id"]]
        state = o["inferred"]["state"]
        if p["used"] and state in (STATE_FLOODED, STATE_DRAINED):
            looks.append((parse_ms(p["datetime"]), p["datetime"], o["stage"], state))
    looks.sort()

    a0, a1 = params["awd_window_days_after_transplant"]
    early_flooded = [lk for lk in looks if lk[2] == "early" and lk[3] == STATE_FLOODED]
    if early_flooded:
        t_ms, source = early_flooded[0][0], "inferred"
    else:
        tw0 = parse_ms(params["transplant_window"]["start"])
        tw1 = parse_ms(params["transplant_window"]["end"])
        t_ms, source = tw0 + (tw1 - tw0) // 2, "assumed"
    ws_ms, we_ms = t_ms + a0 * DAY_MS, t_ms + a1 * DAY_MS
    window = {"start": fmt_dt(ws_ms), "end": fmt_dt(we_ms), "source": source}

    in_window = [lk for lk in looks if ws_ms <= lk[0] < we_ms]
    n = len(in_window)
    d = sum(1 for lk in in_window if lk[3] == STATE_DRAINED)
    if n == 0:
        p_catch, k_star = 0.0, None
    else:
        sim_looks = [(lk[1], lk[2]) for lk in in_window]
        key = window["start"] + "|" + ",".join(lk[1] for lk in in_window)
        win = (window["start"], window["end"])
        awd = simulate(sim_looks, params, n_sim, derive(seed, "awd|" + key), "awd", win)
        cf = simulate(sim_looks, params, n_sim, derive(seed, "cf|" + key), "cf", win)
        p_catch = ge(awd, 1)
        k_star = k_star_from(cf, params["cf_false_flag_max"])

    verdict = awd_verdict(n, d, p_catch, k_star, params["awd_miss_max"])
    reason = awd_reason(verdict, n, d, p_catch, k_star)

    early = [lk for lk in looks if lk[2] == "early"]
    signal, dsr_reason = dsr_signal(early, params["dsr_min_early_looks"], stages["mid_start"])

    out = {"v": 1, "run_id": run_id}
    if fixture is not None:
        out["fixture"] = fixture
    out.update({"field_id": field_id,
                "awd": {"window": window, "clear_looks": n, "drained_hits": d, "p_catch_ge1_if_awd": p_catch,
                        "k_star": k_star, "verdict": verdict, "reason": reason},
                "dsr": {"signal": signal, "reason": dsr_reason}})
    return out


def awd_verdict(n: int, d: int, p_catch: float, k_star: int | None, awd_miss_max: float) -> str:
    if k_star is not None and d >= k_star:
        return "consistent"
    if n >= 1 and d == 0 and p_catch >= 1 - awd_miss_max:
        return "inconsistent"
    return "not_enough_evidence"


def awd_reason(verdict: str, n: int, d: int, p_catch: float, k_star: int | None) -> str:
    looks = looks_text(n)
    if verdict == "consistent":
        return f"Drained on {d} of {looks}, more than a continuously flooded field would show."
    if verdict == "inconsistent":
        return (f"Flooded on {all_looks_text(n)}; a field practicing AWD would have been caught drained "
                f"{pct_down(p_catch)}% of the time.")
    if n == 0:
        return "No clear looks inside the AWD window."
    if d == 0:
        return (f"Flooded on {all_looks_text(n)}, but these dates would catch a field practicing AWD only "
                f"{pct_down(p_catch)}% of the time.")
    if k_star is None:
        return f"{looks} cannot separate AWD from continuous flooding."
    return f"Drained on {d} of {looks}; {k_star} are needed to rule out a single drainage."


def dsr_signal(early_looks: Sequence[tuple], min_looks: int, mid_start: str) -> tuple[str, str]:
    """early_looks: (ms, datetime, stage, state), sorted, clear, stage early."""
    n = len(early_looks)
    if n == 0 and min_looks > 0:
        return "unknown", f"No clear looks before {mid_start}."
    if n < min_looks:
        return "unknown", f"Only {looks_text(n)} before {mid_start}."
    flooded = [lk for lk in early_looks if lk[3] == STATE_FLOODED]
    if flooded:
        return "transplant_signal", f"Standing water on {flooded[0][1][:10]}, typical of puddled transplanting."
    return "dsr_signal", f"Dry on all {looks_text(n)} before {mid_start}, typical of direct seeding."


# ----------------------------------------------------------------------------------------------- states
STATE_CODE = {STATE_FLOODED: "F", STATE_DRAINED: "D", STATE_UNCERTAIN: "U"}


def states(field_ids: Sequence[str], passes: Sequence[dict], observations: Iterable[dict], run_id: str,
           fixture: bool | None = None) -> dict:
    """CONTRACTS.md B3.13: one character per field per used pass, for the map's season animation."""
    used = sorted((p for p in passes if p["used"]), key=lambda p: (parse_ms(p["datetime"]), p["pass_id"]))
    col = {p["pass_id"]: i for i, p in enumerate(used)}
    ids = sorted(field_ids)
    row = {fid: i for i, fid in enumerate(ids)}
    grid = [["-"] * len(used) for _ in ids]
    for o in observations:
        if o["pass_id"] in col and o["field_id"] in row:
            grid[row[o["field_id"]]][col[o["pass_id"]]] = STATE_CODE[o["inferred"]["state"]]
    out = {"v": 1, "run_id": run_id}
    if fixture is not None:
        out["fixture"] = fixture
    out.update({"pass_ids": [p["pass_id"] for p in used], "field_ids": ids, "states": ["".join(r) for r in grid]})
    return out


# ----------------------------------------------------------------------------------------------- story
def story(aoi: dict, fields: Sequence[dict], summaries: dict, used_passes: int, run_id: str,
          fixture: bool | None = None) -> dict:
    """CONTRACTS.md B3.11. fields: feature properties; summaries: field_id -> field_summary line."""
    def decided(fid):
        return summaries[fid]["awd"]["verdict"] != "not_enough_evidence"

    total = len(fields)
    n_decided = sum(1 for f in fields if decided(f["field_id"]))
    share = n_decided / total if total else 0.0
    if total == 0:
        raise ValueError("story needs at least one field")
    best_tile, best_share = None, -1.0
    for tile in aoi["tiles"]:
        tf = [f for f in fields if f["tile"] == tile["id"]]
        if not tf:
            continue  # a tile with no fields can never be the hero tile
        s = sum(1 for f in tf if decided(f["field_id"])) / len(tf)
        if s > best_share:
            best_tile, best_share = tile["id"], s
    in_tile = sorted((f for f in fields if f["tile"] == best_tile), key=lambda f: f["field_id"])

    def order(f):
        a = summaries[f["field_id"]]["awd"]
        return (-a["drained_hits"], -a["clear_looks"], -f["area_ha"], f["field_id"])

    consistent = [f for f in in_tile if summaries[f["field_id"]]["awd"]["verdict"] == "consistent"]
    decided_f = [f for f in in_tile if decided(f["field_id"])]
    pool = consistent or decided_f
    hero = min(pool, key=order)["field_id"] if pool else in_tile[0]["field_id"]  # in_tile is sorted by field_id
    p = pct(share)
    out = {"v": 1, "run_id": run_id}
    if fixture is not None:
        out["fixture"] = fixture
    out.update({"hero_tile": best_tile, "hero_field_id": hero,
                "headline": {"text": f"{p}% of {total} rice fields had enough clear radar looks for a drainage verdict.",
                             "tag": "INFERRED"},
                "counts": {"passes": used_passes, "fields": total, "tiles": len(aoi["tiles"]),
                           "pct_fields_with_enough_looks": p}})
    return out


# ----------------------------------------------------------------------------------------------- geometry (ranking)
class GeometryError(ValueError):
    """Claim geometry the ranking cannot use (open ring, too few vertices, no interior, unsupported type)."""


def _rings_of(geometry: dict) -> list[list[list]]:
    """Polygons as lists of rings."""
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return list(geometry["coordinates"])
    raise GeometryError(f"unsupported geometry type {geometry['type']!r}")


def planar_area(ring: Sequence[Sequence[float]]) -> float:
    """|shoelace| in lon/lat units; only used to pick the largest polygon of a MultiPolygon."""
    s = 0.0
    for i in range(len(ring) - 1):
        s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return abs(s) / 2


def check_rings(geometry: dict) -> None:
    polys = _rings_of(geometry)
    if not polys or any(not poly for poly in polys):
        raise GeometryError("polygon has no rings")
    for poly in polys:
        for ring in poly:
            if len(ring) < 4 or ring[0][0] != ring[-1][0] or ring[0][1] != ring[-1][1]:
                raise GeometryError("polygon rings must be closed and have at least 4 positions")


def representative_point(geometry: dict) -> tuple[float, float]:
    """CONTRACTS.md B6 step 1: a deterministic point inside the claim.

    Point: the point. Polygon/MultiPolygon: take the part whose outer ring has the largest planar_area (first
    part wins ties); use the average of its vertices (closing vertex excluded) if that lies inside the outer
    ring; otherwise the midpoint of the first interior span of the horizontal line through that average.
    """
    if geometry["type"] == "Point":
        return geometry["coordinates"][0], geometry["coordinates"][1]
    check_rings(geometry)
    polys = _rings_of(geometry)
    best = polys[0]
    best_area = planar_area(best[0])
    for poly in polys[1:]:
        a = planar_area(poly[0])
        if a > best_area:
            best, best_area = poly, a
    outer = best[0]
    ring = outer[:-1]
    sx = 0.0
    sy = 0.0
    for pt in ring:
        sx += pt[0]
        sy += pt[1]
    cx, cy = sx / len(ring), sy / len(ring)
    if _in_ring(cx, cy, outer):
        return cx, cy
    xs = []
    j = len(outer) - 1
    for i in range(len(outer)):
        xi, yi = outer[i][0], outer[i][1]
        xj, yj = outer[j][0], outer[j][1]
        if (yi > cy) != (yj > cy):
            xs.append((xj - xi) * (cy - yi) / (yj - yi) + xi)
        j = i
    xs.sort()
    if len(xs) < 2:
        raise GeometryError("polygon has no interior (degenerate ring)")
    return (xs[0] + xs[1]) / 2, cy


def _in_ring(x: float, y: float, ring: Sequence[Sequence[float]]) -> bool:
    """Even-odd ray casting, exactly: (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def contains(geometry: dict, x: float, y: float) -> bool:
    for poly in _rings_of(geometry):
        if _in_ring(x, y, poly[0]) and not any(_in_ring(x, y, hole) for hole in poly[1:]):
            return True
    return False


# ----------------------------------------------------------------------------------------------- ranking
AWD_WEIGHT = {"inconsistent": 1.0, "not_enough_evidence": 0.6, "consistent": 0.1}
DSR_WEIGHT = {"transplant_signal": 1.0, "unknown": 0.6, "dsr_signal": 0.1}
UNMATCHED_WEIGHT = 0.8
NO_SUMMARY_WEIGHT = 0.6
UNMATCHED_STRATUM = "~unmatched"


class RankError(ValueError):
    """A request the ranking rejects; `code` becomes the API error code (HTTP 400)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _reason_parts(claimed: Sequence[str], summary: dict | None) -> str:
    if summary is None:
        return "No season summary yet"
    parts = []
    if "awd" in claimed:
        a = summary["awd"]
        looks = looks_text(a["clear_looks"])
        parts.append({"inconsistent": f"Not consistent with AWD ({a['drained_hits']} of {looks} drained)",
                      "not_enough_evidence": f"Not enough evidence for AWD ({looks})",
                      "consistent": f"Consistent with AWD ({a['drained_hits']} of {looks} drained)"}[a["verdict"]])
    if "dsr" in claimed:
        parts.append({"transplant_signal": "DSR: transplant signal", "unknown": "DSR: signal unknown",
                      "dsr_signal": "DSR: DSR signal"}[summary["dsr"]["signal"]])
    return "; ".join(parts)


def rank(body: bytes, fields: Sequence[dict], summaries: dict, run_id: str, created_at: str,
         fixture: bool) -> dict:
    """CONTRACTS.md B6 ranking. body = exact request bytes; fields = GeoJSON features."""
    import json

    request = json.loads(body.decode("utf-8"))
    claims = request["claims"]["features"]
    budget = int(request["budget"])
    input_hash = hashlib.sha256(body).hexdigest()
    seed = int(request["seed"]) if request.get("seed") is not None else int(input_hash[:8], 16)

    ids = []
    for i, claim in enumerate(claims, start=1):
        cid = claim["properties"].get("claim_id")
        ids.append(cid if cid is not None else f"#{i}")
        if claim["geometry"]["type"] != "Point":
            try:
                check_rings(claim["geometry"])
                representative_point(claim["geometry"])
            except GeometryError as exc:
                raise RankError("invalid_geometry", f"claim {ids[-1]}: {exc}") from None
    if len(set(ids)) != len(ids):
        dup = next(c for c in ids if ids.count(c) > 1)
        raise RankError("duplicate_claim_id", f"claim_id {dup!r} appears more than once")

    by_id = {f["properties"]["field_id"]: f for f in fields}
    ordered = sorted(fields, key=lambda f: f["properties"]["field_id"])
    candidates: dict[str, dict] = {}
    order: list[str] = []
    matched = unmatched = 0
    for claim, claim_id in zip(claims, ids):
        props = claim["properties"]
        claimed = [c for c in ("awd", "dsr") if c in props["claimed"]]
        field = by_id.get(props.get("field_id")) if props.get("field_id") else None
        if field is None:
            x, y = representative_point(claim["geometry"])
            field = next((f for f in ordered if contains(f["geometry"], x, y)), None)
        if field is None:
            unmatched += 1
            key = "~" + claim_id
            area = props.get("area_ha")
            candidates[key] = {"key": key, "claim_id": claim_id, "field_id": None, "district": None,
                               "weight": UNMATCHED_WEIGHT,
                               "area": area if isinstance(area, (int, float)) and area > 0 else 1.0,
                               "reason": "Claim does not match a mapped rice field"}
            order.append(key)
            continue
        matched += 1
        fid = field["properties"]["field_id"]
        if fid in candidates:
            merged = candidates[fid]
            merged["claimed"] = [c for c in ("awd", "dsr") if c in merged["claimed"] or c in claimed]
        else:
            candidates[fid] = {"key": fid, "claim_id": claim_id, "field_id": fid,
                               "district": field["properties"]["district"], "claimed": claimed,
                               "area": field["properties"]["area_ha"]}
            order.append(fid)

    for cand in candidates.values():
        if cand["field_id"] is None:
            continue
        summary = summaries.get(cand["field_id"])
        if summary is None:
            weight = NO_SUMMARY_WEIGHT
        else:
            ws = []
            if "awd" in cand["claimed"]:
                ws.append(AWD_WEIGHT[summary["awd"]["verdict"]])
            if "dsr" in cand["claimed"]:
                ws.append(DSR_WEIGHT[summary["dsr"]["signal"]])
            weight = max(ws)
        cand["weight"] = weight
        cand["reason"] = _reason_parts(cand["claimed"], summary)

    for cand in candidates.values():
        cand["score"] = cand["weight"] * cand["area"]

    pool = [candidates[k] for k in order]
    n = min(budget, len(pool))
    n_random = (n + 2) // 5
    n_score = n - n_random
    by_score = sorted(pool, key=lambda c: (-c["score"], -c["weight"], c["key"]))
    score_picks = by_score[:n_score]
    rest = by_score[n_score:]

    strata: dict[str, list] = {}
    for cand in rest:
        strata.setdefault(cand["district"] or UNMATCHED_STRATUM, []).append(cand)
    names = sorted(strata)
    quotas = {}
    remainders = []
    if rest:
        for name in names:
            exact_num = n_random * len(strata[name])
            quotas[name] = exact_num // len(rest)
            remainders.append((-(exact_num % len(rest)), name))
        leftover = n_random - sum(quotas.values())
        for _, name in sorted(remainders):
            if leftover == 0:
                break
            if quotas[name] < len(strata[name]):
                quotas[name] += 1
                leftover -= 1
    rng = Mulberry32(seed)
    random_picks = []
    for name in names:
        items = sorted(strata[name], key=lambda c: c["key"])
        m, quota = len(items), quotas.get(name, 0)
        for i in range(quota):
            j = i + int(rng() * (m - i))
            items[i], items[j] = items[j], items[i]
        random_picks.extend(items[:quota])

    ranked = []
    for pick, group in (("score", score_picks), ("random", random_picks)):
        for cand in group:
            reason = cand["reason"] if pick == "score" else "Random check; " + cand["reason"]
            ranked.append({"rank": len(ranked) + 1, "claim_id": cand["claim_id"], "field_id": cand["field_id"],
                           "district": cand["district"], "weight": cand["weight"], "score": cand["score"],
                           "reason": reason, "pick": pick})

    audit_id = "a_" + hashlib.sha256(f"{run_id}|{input_hash}|{budget}|{seed}".encode()).hexdigest()[:16]
    synthetic = all(bool(c["properties"].get("synthetic")) for c in claims)
    return {"v": 1, "run_id": run_id, "fixture": fixture, "audit_id": audit_id, "created_at": created_at,
            "budget": budget, "seed": seed, "input_hash": input_hash, "synthetic": synthetic,
            "matched": matched, "unmatched": unmatched, "ranked": ranked, "notice": NOTICE}
