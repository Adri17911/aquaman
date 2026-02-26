"""Dawn/dusk and curve scheduler: applies LED brightness based on schedules."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from database import db
from mqtt_worker import mqtt_worker

logger = logging.getLogger("scheduler")

# Days: 0=Sun, 1=Mon, ..., 6=Sat (user-facing). Python: 0=Mon, 6=Sun.
def _current_dow_matches(days_of_week: str) -> bool:
    try:
        allowed = {int(x.strip()) for x in days_of_week.split(",") if x.strip()}
    except ValueError:
        return False
    # Python weekday: Mon=0, Sun=6. Our 0=Sun -> 6, 1=Mon -> 0, 2=Tue -> 1, ...
    py_dow = datetime.now().weekday()  # 0=Mon, 6=Sun
    our_dow = (py_dow + 1) % 7  # Convert: Mon=1, Tue=2, ..., Sun=0
    return our_dow in allowed


def _parse_time(s: str) -> tuple[int, int] | None:
    """Parse HH:MM or H:MM, return (hour, minute)."""
    s = (s or "").strip()
    if not s:
        return None
    parts = s.split(":")
    if len(parts) != 2:
        return None
    try:
        h, m = int(parts[0]), int(parts[1])
        if 0 <= h <= 23 and 0 <= m <= 59:
            return (h, m)
    except ValueError:
        pass
    return None


def _minutes_since_midnight(h: int, m: int) -> int:
    return h * 60 + m


def _compute_brightness(schedule: dict) -> int | None:
    """Return target brightness 0-100 for this schedule at current time, or None if not applicable."""
    if not _current_dow_matches(schedule.get("days_of_week", "")):
        return None
    now = datetime.now()
    now_mins = _minutes_since_midnight(now.hour, now.minute)

    dawn = _parse_time(schedule.get("dawn_time", ""))
    dusk = _parse_time(schedule.get("dusk_time", ""))
    if not dawn or not dusk:
        return None

    dawn_mins = _minutes_since_midnight(*dawn)
    dusk_mins = _minutes_since_midnight(*dusk)
    dawn_dur = max(1, int(schedule.get("dawn_duration_minutes", 30)))
    dusk_dur = max(1, int(schedule.get("dusk_duration_minutes", 30)))
    target = max(0, min(100, int(schedule.get("target_brightness", 100))))

    dawn_end = dawn_mins + dawn_dur
    dusk_end = dusk_mins + dusk_dur
    if dusk_end >= 24 * 60:
        dusk_end -= 24 * 60

    if dawn_mins < dusk_mins:
        # Same day: dawn 07:00, dusk 21:00
        if now_mins < dawn_mins:
            return 0
        if now_mins < dawn_end:
            return int(((now_mins - dawn_mins) / dawn_dur) * target)
        if now_mins < dusk_mins:
            return target
        if now_mins < dusk_end:
            progress = (now_mins - dusk_mins) / dusk_dur
            return int((1 - progress) * target)
        return 0
    else:
        # Overnight: dusk 02:00, dawn 08:00. [0,dusk)=day, [dusk,dusk_end)=fade, [dusk_end,dawn)=night, [dawn,dawn_end)=fade, [dawn_end,24)=day
        if now_mins < dusk_mins:
            return target  # 0 to dusk = day (from previous)
        if now_mins < dusk_end:
            progress = (now_mins - dusk_mins) / dusk_dur
            return int((1 - progress) * target)
        if now_mins < dawn_mins:
            return 0  # night
        if now_mins < dawn_end:
            return int(((now_mins - dawn_mins) / dawn_dur) * target)
        return target  # day


def _compute_brightness_from_curve(schedule: dict) -> int | None:
    """Return target brightness 0-100 for curve schedule at current time, or None if not applicable."""
    if not _current_dow_matches(schedule.get("days_of_week", "")):
        return None
    curve = schedule.get("curve_points")
    if not curve or not isinstance(curve, list) or len(curve) < 2:
        return None
    now = datetime.now()
    now_mins = _minutes_since_midnight(now.hour, now.minute)
    points = []
    for p in curve:
        if isinstance(p, (list, tuple)) and len(p) >= 2:
            m, b = int(p[0]), int(p[1])
            points.append((max(0, min(1440, m)), max(0, min(100, b))))
    points.sort(key=lambda x: x[0])
    if len(points) < 2:
        return None
    if now_mins <= points[0][0]:
        return points[0][1]
    if now_mins >= points[-1][0]:
        return points[-1][1]
    for i in range(len(points) - 1):
        m1, b1 = points[i]
        m2, b2 = points[i + 1]
        if m1 <= now_mins <= m2:
            if m2 == m1:
                return b2
            t = (now_mins - m1) / (m2 - m1)
            return int(b1 + t * (b2 - b1))
    return 0


def run_dawn_dusk_tick() -> None:
    """Check all enabled dawn/dusk and curve schedules, send LED brightness commands."""
    if not mqtt_worker.connected:
        return
    seen_devices: set[str] = set()
    for s in db.list_enabled_dawn_dusk_schedules():
        device_id = s.get("device_id")
        if not device_id or not db.device_online(device_id):
            continue
        brightness = _compute_brightness(s)
        if brightness is None:
            continue
        seen_devices.add(device_id)
        try:
            mqtt_worker.publish_command(device_id, "led", "set_brightness", {"value": brightness}, "scheduler")
        except Exception as e:
            logger.warning("Scheduler failed for %s: %s", device_id, e)
    for s in db.list_enabled_curve_schedules():
        device_id = s.get("device_id")
        if not device_id or not db.device_online(device_id):
            continue
        brightness = _compute_brightness_from_curve(s)
        if brightness is None:
            continue
        seen_devices.add(device_id)
        try:
            mqtt_worker.publish_command(device_id, "led", "set_brightness", {"value": brightness}, "scheduler")
        except Exception as e:
            logger.warning("Scheduler curve failed for %s: %s", device_id, e)
