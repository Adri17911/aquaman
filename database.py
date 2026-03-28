"""Database layer for Aquarium Automation Platform."""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Generator

from config import DB_PATH


_UNSET = object()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(self, path: Path = DB_PATH) -> None:
        self.path = path
        self._lock = Lock()

    @contextmanager
    def _conn(self) -> Generator[sqlite3.Connection, None, None]:
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def init(self) -> None:
        with self._lock, self._conn() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS devices (
                    device_id TEXT PRIMARY KEY,
                    name TEXT,
                    online INTEGER NOT NULL DEFAULT 0,
                    last_seen_ts TEXT,
                    last_status_ts TEXT,
                    last_ip TEXT,
                    capabilities TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS telemetry (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts TEXT NOT NULL,
                    device_id TEXT NOT NULL,
                    temp REAL,
                    lux REAL,
                    water_ok INTEGER,
                    heater_on INTEGER,
                    water_voltage REAL,
                    button_voltage REAL,
                    button_pressed INTEGER,
                    led_on INTEGER,
                    led_brightness INTEGER,
                    raw TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_telemetry_device_ts ON telemetry(device_id, ts);

                CREATE TABLE IF NOT EXISTS status_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts TEXT NOT NULL,
                    device_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    payload TEXT
                );

                CREATE TABLE IF NOT EXISTS commands (
                    correlation_id TEXT PRIMARY KEY,
                    ts TEXT NOT NULL,
                    device_id TEXT NOT NULL,
                    component TEXT NOT NULL,
                    action TEXT NOT NULL,
                    payload_json TEXT,
                    source TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'SENT',
                    sent_at TEXT NOT NULL,
                    acked_at TEXT,
                    error TEXT
                );

                CREATE TABLE IF NOT EXISTS acks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts TEXT NOT NULL,
                    device_id TEXT NOT NULL,
                    component TEXT NOT NULL,
                    correlation_id TEXT,
                    payload_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS schedules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    scenario_type TEXT NOT NULL DEFAULT 'dawn_dusk',
                    dawn_time TEXT NOT NULL,
                    dusk_time TEXT NOT NULL,
                    dawn_duration_minutes INTEGER NOT NULL DEFAULT 30,
                    dusk_duration_minutes INTEGER NOT NULL DEFAULT 30,
                    target_brightness INTEGER NOT NULL DEFAULT 100,
                    days_of_week TEXT NOT NULL,
                    curve_points TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_schedules_device ON schedules(device_id);

                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    is_admin INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
            """)
            try:
                conn.execute("ALTER TABLE schedules ADD COLUMN curve_points TEXT")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE telemetry ADD COLUMN humidity REAL")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE devices ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1")
            except Exception:
                pass
            for col_sql in (
                "ALTER TABLE telemetry ADD COLUMN filter_ble_connected INTEGER",
                "ALTER TABLE telemetry ADD COLUMN filter_power INTEGER",
                "ALTER TABLE telemetry ADD COLUMN filter_mode TEXT",
                "ALTER TABLE telemetry ADD COLUMN filter_state_blob_hex TEXT",
                "ALTER TABLE telemetry ADD COLUMN filter_ble_error TEXT",
                "ALTER TABLE telemetry ADD COLUMN filter_last_address TEXT",
            ):
                try:
                    conn.execute(col_sql)
                except Exception:
                    pass

    def list_devices(self) -> list[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT device_id, name, online, last_seen_ts, last_status_ts, last_ip, capabilities, enabled "
                "FROM devices ORDER BY last_seen_ts DESC"
            ).fetchall()
            result = []
            for r in rows:
                caps = None
                if r["capabilities"]:
                    try:
                        caps = json.loads(r["capabilities"])
                    except json.JSONDecodeError:
                        pass
                enabled = r["enabled"] if "enabled" in r.keys() else 1
                result.append({
                    "device_id": r["device_id"],
                    "name": r["name"] or r["device_id"],
                    "online": bool(r["online"]),
                    "last_seen_ts": r["last_seen_ts"],
                    "last_status_ts": r["last_status_ts"],
                    "last_ip": r["last_ip"],
                    "capabilities": caps or {},
                    "enabled": bool(enabled),
                })
            return result

    def get_device(self, device_id: str) -> dict[str, Any] | None:
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT device_id, name, online, last_seen_ts, last_status_ts, last_ip, capabilities, enabled "
                "FROM devices WHERE device_id = ?", (device_id,)
            ).fetchone()
            if not row:
                return None
            caps = {}
            if row["capabilities"]:
                try:
                    caps = json.loads(row["capabilities"])
                except json.JSONDecodeError:
                    pass
            enabled = row["enabled"] if "enabled" in row.keys() else 1
            return {
                "device_id": row["device_id"],
                "name": row["name"] or row["device_id"],
                "online": bool(row["online"]),
                "last_seen_ts": row["last_seen_ts"],
                "last_status_ts": row["last_status_ts"],
                "last_ip": row["last_ip"],
                "capabilities": caps,
                "enabled": bool(enabled),
            }

    def update_device(
        self, device_id: str, name: str | None = None, enabled: bool | None = None
    ) -> dict[str, Any] | None:
        dev = self.get_device(device_id)
        if not dev:
            return None
        updates = []
        params: list[Any] = []
        if name is not None:
            updates.append("name = ?")
            params.append((name or device_id).strip() or device_id)
        if enabled is not None:
            updates.append("enabled = ?")
            params.append(1 if enabled else 0)
        if not updates:
            return dev
        params.append(device_id)
        with self._lock, self._conn() as conn:
            conn.execute(
                f"UPDATE devices SET {', '.join(updates)} WHERE device_id = ?",
                params,
            )
        return self.get_device(device_id)

    def device_online(self, device_id: str) -> bool:
        dev = self.get_device(device_id)
        return dev is not None and dev.get("online", False)

    def add_device_manual(self, device_id: str, name: str | None = None) -> None:
        """Add or update a device manually (e.g. before first telemetry)."""
        now = utc_now()
        display_name = (name or device_id).strip() or device_id
        caps_json = json.dumps({"heater": True, "led": True})
        with self._lock, self._conn() as conn:
            conn.execute("""
                INSERT INTO devices (device_id, name, online, last_seen_ts, last_status_ts, last_ip, capabilities, created_at)
                VALUES (?, ?, 0, NULL, NULL, NULL, ?, ?)
                ON CONFLICT(device_id) DO UPDATE SET name = excluded.name
            """, (device_id, display_name, caps_json, now))

    def list_schedules(self, device_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            if device_id:
                rows = conn.execute(
                    "SELECT * FROM schedules WHERE device_id = ? ORDER BY name",
                    (device_id,)
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM schedules ORDER BY device_id, name").fetchall()
            return [_schedule_row_to_dict(r) for r in rows]

    def get_schedule(self, schedule_id: int) -> dict[str, Any] | None:
        with self._lock, self._conn() as conn:
            row = conn.execute("SELECT * FROM schedules WHERE id = ?", (schedule_id,)).fetchone()
            return _schedule_row_to_dict(row) if row else None

    def create_schedule(
        self,
        device_id: str,
        name: str,
        dawn_time: str = "07:00",
        dusk_time: str = "21:00",
        dawn_duration_minutes: int = 30,
        dusk_duration_minutes: int = 30,
        target_brightness: int = 100,
        days_of_week: str = "0,1,2,3,4,5,6",
        enabled: bool = True,
        scenario_type: str = "dawn_dusk",
        curve_points: str | None = None,
    ) -> dict[str, Any]:
        now = utc_now()
        with self._lock, self._conn() as conn:
            cur = conn.execute("""
                INSERT INTO schedules (device_id, name, enabled, scenario_type, dawn_time, dusk_time,
                    dawn_duration_minutes, dusk_duration_minutes, target_brightness, days_of_week, curve_points, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (device_id, name, 1 if enabled else 0, scenario_type, dawn_time, dusk_time,
                  dawn_duration_minutes, dusk_duration_minutes, target_brightness, days_of_week, curve_points, now))
            last_id = cur.lastrowid
        return self.get_schedule(last_id) or {}

    def update_schedule(
        self,
        schedule_id: int,
        name: str | None = None,
        dawn_time: str | None = None,
        dusk_time: str | None = None,
        dawn_duration_minutes: int | None = None,
        dusk_duration_minutes: int | None = None,
        target_brightness: int | None = None,
        days_of_week: str | None = None,
        enabled: bool | None = None,
        scenario_type: str | None = None,
        curve_points: str | None = _UNSET,  # type: ignore[assignment]
    ) -> dict[str, Any] | None:
        s = self.get_schedule(schedule_id)
        if not s:
            return None
        updates = []
        params: list[Any] = []
        if name is not None:
            updates.append("name = ?")
            params.append(name)
        if dawn_time is not None:
            updates.append("dawn_time = ?")
            params.append(dawn_time)
        if dusk_time is not None:
            updates.append("dusk_time = ?")
            params.append(dusk_time)
        if dawn_duration_minutes is not None:
            updates.append("dawn_duration_minutes = ?")
            params.append(dawn_duration_minutes)
        if dusk_duration_minutes is not None:
            updates.append("dusk_duration_minutes = ?")
            params.append(dusk_duration_minutes)
        if target_brightness is not None:
            updates.append("target_brightness = ?")
            params.append(target_brightness)
        if days_of_week is not None:
            updates.append("days_of_week = ?")
            params.append(days_of_week)
        if enabled is not None:
            updates.append("enabled = ?")
            params.append(1 if enabled else 0)
        if scenario_type is not None:
            updates.append("scenario_type = ?")
            params.append(scenario_type)
        if curve_points is not _UNSET:
            updates.append("curve_points = ?")
            params.append(curve_points)
        if not updates:
            return s
        params.append(schedule_id)
        with self._lock, self._conn() as conn:
            conn.execute(
                f"UPDATE schedules SET {', '.join(updates)} WHERE id = ?",
                params
            )
        return self.get_schedule(schedule_id)

    def delete_schedule(self, schedule_id: int) -> bool:
        with self._lock, self._conn() as conn:
            cur = conn.execute("DELETE FROM schedules WHERE id = ?", (schedule_id,))
            return cur.rowcount > 0

    def list_enabled_dawn_dusk_schedules(self) -> list[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM schedules WHERE enabled = 1 AND scenario_type = 'dawn_dusk'"
            ).fetchall()
            return [_schedule_row_to_dict(r) for r in rows]

    def list_enabled_curve_schedules(self) -> list[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT * FROM schedules WHERE enabled = 1 AND scenario_type = 'curve' AND curve_points IS NOT NULL"
            ).fetchall()
            return [_schedule_row_to_dict(r) for r in rows]

    # --- Users ---
    def count_users(self) -> int:
        with self._lock, self._conn() as conn:
            row = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()
            return row["n"] or 0

    def create_user(self, username: str, password_hash: str, is_admin: bool = False) -> dict[str, Any]:
        now = utc_now()
        with self._lock, self._conn() as conn:
            conn.execute(
                "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)",
                (username.strip().lower(), password_hash, 1 if is_admin else 0, now),
            )
            row_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        return self.get_user_by_id(row_id) or {}

    def get_user_by_id(self, user_id: int) -> dict[str, Any] | None:
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT id, username, is_admin, created_at FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            return _user_row_to_dict(row) if row else None

    def get_user_by_username(self, username: str) -> dict[str, Any] | None:
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT id, username, password_hash, is_admin, created_at FROM users WHERE username = ?",
                (username.strip().lower(),),
            ).fetchone()
            return _user_row_to_dict(row) if row else None

    def list_users(self) -> list[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT id, username, is_admin, created_at FROM users ORDER BY username"
            ).fetchall()
            return [_user_row_to_dict(r) for r in rows]

    def delete_user(self, user_id: int) -> bool:
        with self._lock, self._conn() as conn:
            cur = conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
            return cur.rowcount > 0

    def _device_capabilities_from_telemetry(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Infer device type from telemetry payload. Room sensor has humidity, no lux/water/heater/led."""
        has_controller = any(payload.get(k) is not None for k in ("lux", "water", "heater", "led"))
        if has_controller:
            return {"heater": True, "led": True}
        if "humidity" in payload:
            return {"room_sensor": True, "temp": True, "humidity": True}
        return {"heater": True, "led": True}

    def upsert_device_from_telemetry(self, device_id: str, payload: dict[str, Any]) -> None:
        now = utc_now()
        ip = str(payload.get("ip", "")) or None
        caps = self._device_capabilities_from_telemetry(payload)
        caps_json = json.dumps(caps)

        with self._lock, self._conn() as conn:
            conn.execute("""
                INSERT INTO devices (device_id, name, online, last_seen_ts, last_status_ts, last_ip, capabilities, created_at)
                VALUES (?, ?, 1, ?, ?, ?, ?, ?)
                ON CONFLICT(device_id) DO UPDATE SET
                    online = 1,
                    last_seen_ts = excluded.last_seen_ts,
                    last_ip = COALESCE(excluded.last_ip, devices.last_ip),
                    capabilities = excluded.capabilities
            """, (device_id, device_id, now, now, ip, caps_json, now))

    def upsert_device_from_status(self, device_id: str, status: str, payload: dict[str, Any]) -> None:
        now = utc_now()
        ip = str(payload.get("ip", "")) or None
        online = 1 if status.lower() == "online" else 0

        with self._lock, self._conn() as conn:
            conn.execute("""
                INSERT INTO status_events (ts, device_id, status, payload)
                VALUES (?, ?, ?, ?)
            """, (now, device_id, status, json.dumps(payload)))

            conn.execute("""
                INSERT INTO devices (device_id, name, online, last_seen_ts, last_status_ts, last_ip, capabilities, created_at)
                VALUES (?, ?, ?, ?, ?, ?, '{}', ?)
                ON CONFLICT(device_id) DO UPDATE SET
                    online = excluded.online,
                    last_seen_ts = COALESCE(devices.last_seen_ts, excluded.last_seen_ts),
                    last_status_ts = excluded.last_status_ts,
                    last_ip = COALESCE(excluded.last_ip, devices.last_ip)
            """, (device_id, device_id, online, now, now, ip, now))

    def insert_telemetry(self, device_id: str, payload: dict[str, Any]) -> None:
        now = utc_now()
        temp = _float(payload.get("temp"))
        lux = _float(payload.get("lux"))
        humidity = _float(payload.get("humidity"))
        water_ok = _bool(payload.get("water"))
        heater_on = _bool(payload.get("heater"))
        water_voltage = _float(payload.get("water_voltage"))
        button_voltage = _float(payload.get("button_voltage"))
        button_pressed = _bool(payload.get("button_pressed"))
        led_on = _bool(payload.get("led"))
        led_brightness = _int(payload.get("led_brightness"))
        filter_ble_connected = _bool(payload.get("filter_ble_connected"))
        filter_power = _bool(payload.get("filter_power"))
        filter_mode = payload.get("filter_mode")
        filter_mode_s = str(filter_mode).strip() if filter_mode is not None else None
        filter_state_blob_hex = payload.get("filter_state_blob_hex")
        filter_state_hex_s = str(filter_state_blob_hex).strip() if filter_state_blob_hex is not None else None
        filter_ble_error = payload.get("filter_ble_error")
        filter_err_s = str(filter_ble_error).strip() if filter_ble_error is not None else None
        fla = payload.get("filter_last_address")
        filter_last_addr_s = str(fla).strip() if fla is not None else None
        raw = json.dumps(payload)

        with self._lock, self._conn() as conn:
            conn.execute("""
                INSERT INTO telemetry (ts, device_id, temp, lux, humidity, water_ok, heater_on, water_voltage,
                    button_voltage, button_pressed, led_on, led_brightness,
                    filter_ble_connected, filter_power, filter_mode, filter_state_blob_hex, filter_ble_error,
                    filter_last_address, raw)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (now, device_id, temp, lux, humidity, _sql_bool(water_ok), _sql_bool(heater_on),
                  water_voltage, button_voltage, _sql_bool(button_pressed),
                  _sql_bool(led_on), led_brightness,
                  _sql_bool(filter_ble_connected), _sql_bool(filter_power),
                  filter_mode_s, filter_state_hex_s, filter_err_s,
                  filter_last_addr_s, raw))

    def get_latest_telemetry(self, device_id: str | None = None) -> dict[str, Any] | None:
        with self._lock, self._conn() as conn:
            if device_id:
                row = conn.execute(
                    "SELECT * FROM telemetry WHERE device_id = ? ORDER BY id DESC LIMIT 1",
                    (device_id,)
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT * FROM telemetry ORDER BY id DESC LIMIT 1"
                ).fetchone()
            if not row:
                return None
            return _row_to_telemetry(row)

    def get_telemetry_log(
        self, device_id: str, limit: int = 100, offset: int = 0
    ) -> list[dict[str, Any]]:
        """Return raw telemetry rows for log viewer (newest first). offset=0 is newest page."""
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT ts, device_id, temp, lux, humidity, water_ok, heater_on, water_voltage, "
                "button_voltage, button_pressed, led_on, led_brightness, "
                "filter_ble_connected, filter_power, filter_mode, filter_state_blob_hex, filter_ble_error, filter_last_address "
                "FROM telemetry WHERE device_id = ? ORDER BY ts DESC LIMIT ? OFFSET ?",
                (device_id, limit, offset),
            ).fetchall()
            return [
                {
                    "ts": r["ts"],
                    "device_id": r["device_id"],
                    "temp": r["temp"],
                    "lux": r["lux"],
                    "humidity": r["humidity"] if "humidity" in r.keys() else None,
                    "water_ok": bool(r["water_ok"]) if r["water_ok"] is not None else None,
                    "heater_on": bool(r["heater_on"]) if r["heater_on"] is not None else None,
                    "water_voltage": r["water_voltage"],
                    "button_voltage": r["button_voltage"],
                    "button_pressed": bool(r["button_pressed"]) if r["button_pressed"] is not None else None,
                    "led_on": bool(r["led_on"]) if r["led_on"] is not None else None,
                    "led_brightness": r["led_brightness"],
                    "filter_ble_connected": bool(r["filter_ble_connected"]) if "filter_ble_connected" in r.keys() and r["filter_ble_connected"] is not None else None,
                    "filter_power": bool(r["filter_power"]) if "filter_power" in r.keys() and r["filter_power"] is not None else None,
                    "filter_mode": r["filter_mode"] if "filter_mode" in r.keys() else None,
                    "filter_state_blob_hex": r["filter_state_blob_hex"] if "filter_state_blob_hex" in r.keys() else None,
                    "filter_ble_error": r["filter_ble_error"] if "filter_ble_error" in r.keys() else None,
                    "filter_last_address": r["filter_last_address"] if "filter_last_address" in r.keys() else None,
                }
                for r in rows
            ]

    def get_telemetry_series(
        self,
        device_id: str,
        metric: str,
        from_ts: str | None = None,
        to_ts: str | None = None,
        bucket: str | None = None,
        agg: str = "last",
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        valid_cols = {"temp", "lux", "humidity", "water_voltage", "button_voltage", "water_ok", "heater_on", "led_brightness"}
        col = metric if metric in valid_cols else "temp"

        with self._lock, self._conn() as conn:
            where_parts = ["device_id = ?"]
            params: list[Any] = [device_id]
            if from_ts:
                where_parts.append("ts >= ?")
                params.append(from_ts)
            if to_ts:
                where_parts.append("ts <= ?")
                params.append(to_ts)
            where_sql = " AND ".join(where_parts)
            params.append(limit)

            rows = conn.execute(
                f"SELECT ts, {col} as value FROM telemetry WHERE {where_sql} ORDER BY ts DESC LIMIT ?",
                params
            ).fetchall()
            return [{"ts": r["ts"], "value": r["value"]} for r in reversed(rows)]

    def get_telemetry_multi(
        self,
        device_id: str,
        metrics: list[str],
        from_ts: str | None = None,
        to_ts: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Return telemetry with multiple metrics for chart overlay.
        Fetches the most recent `limit` points in the range so the chart right edge matches current values.
        """
        valid_cols = {"temp", "lux", "humidity", "water_voltage", "button_voltage", "water_ok", "heater_on", "led_brightness"}
        cols = [m for m in metrics if m in valid_cols] or ["temp"]
        col_list = ", ".join(cols)

        with self._lock, self._conn() as conn:
            where_parts = ["device_id = ?"]
            params: list[Any] = [device_id]
            if from_ts:
                where_parts.append("ts >= ?")
                params.append(from_ts)
            if to_ts:
                where_parts.append("ts <= ?")
                params.append(to_ts)
            where_sql = " AND ".join(where_parts)
            params.append(limit)

            # Get most recent points (DESC), then return in chronological order (ASC) for the chart
            rows = conn.execute(
                f"SELECT ts, {col_list} FROM telemetry WHERE {where_sql} ORDER BY ts DESC LIMIT ?",
                params
            ).fetchall()
            return [dict(r) for r in reversed(rows)]

    def get_telemetry_multi_bucketed(
        self,
        device_id: str,
        metrics: list[str],
        from_ts: str,
        to_ts: str,
        bucket_seconds: int,
        agg: str = "avg",
        limit: int = 2000,
    ) -> list[dict[str, Any]]:
        """Return telemetry aggregated into time buckets for chart (e.g. 1h, 1d). Uses AVG for numeric cols."""
        valid_cols = {"temp", "lux", "humidity", "water_voltage", "button_voltage", "water_ok", "heater_on", "led_brightness"}
        cols = [m for m in metrics if m in valid_cols] or ["temp"]
        # SQLite: normalize ts to 'YYYY-MM-DD HH:MM:SS', then bucket by epoch seconds
        # strftime('%s', ...) is server-local; bucket boundaries are in epoch UTC via unixepoch
        agg_fn = "AVG" if agg == "avg" else "AVG"
        select_parts = [
            "datetime((cast(strftime('%s', replace(substr(ts,1,19), 'T', ' ')) as integer) / ?) * ?, 'unixepoch') as ts"
        ]
        for c in cols:
            select_parts.append(f"{agg_fn}({c}) as {c}")
        select_sql = ", ".join(select_parts)
        params: list[Any] = [bucket_seconds, bucket_seconds, device_id, from_ts, to_ts, limit]
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                f"SELECT {select_sql} FROM telemetry WHERE device_id = ? AND ts >= ? AND ts <= ? "
                "GROUP BY 1 ORDER BY ts ASC LIMIT ?",
                params,
            ).fetchall()
            return [dict(r) for r in rows]

    def get_telemetry_multi_device(
        self,
        specs: list[tuple[str, list[str]]],
        from_ts: str,
        to_ts: str,
        bucket_seconds: int = 300,
        limit: int = 2000,
    ) -> list[dict[str, Any]]:
        """Return time-aligned telemetry for multiple devices for correlation charts.
        specs: list of (device_id, metrics). Returns list of { ts, device_id__metric: value, ... }.
        """
        if not specs:
            return []
        valid_cols = {"temp", "lux", "humidity", "water_voltage", "button_voltage", "water_ok", "heater_on", "led_brightness"}
        per_device: list[list[dict[str, Any]]] = []
        for device_id, metrics in specs:
            cols = [m for m in metrics if m in valid_cols] or ["temp"]
            per_device.append(
                self.get_telemetry_multi_bucketed(device_id, cols, from_ts, to_ts, bucket_seconds, "avg", limit)
            )
        if not per_device:
            return []
        # Merge on ts: use first series as base, then left-join others on ts
        base = per_device[0]
        if len(per_device) == 1:
            prefix = f"{specs[0][0]}__"
            return [{**{"ts": p["ts"]}, **{(prefix + k): v for k, v in p.items() if k != "ts"}} for p in base]
        key_to_idx: dict[str, int] = {}
        for i, (dev_id, metrics) in enumerate(specs):
            for m in metrics:
                if m in valid_cols:
                    key_to_idx[f"{dev_id}__{m}"] = (i, m)
        merged: list[dict[str, Any]] = []
        for p in base:
            row: dict[str, Any] = {"ts": p["ts"]}
            dev_id0, metrics0 = specs[0]
            for k, v in p.items():
                if k != "ts":
                    row[f"{dev_id0}__{k}"] = v
            for j, (dev_id, metrics) in enumerate(specs[1:], 1):
                pts = per_device[j]
                ts_to_pt = {pt["ts"]: pt for pt in pts}
                other = ts_to_pt.get(p["ts"])
                if other:
                    for k, v in other.items():
                        if k != "ts":
                            row[f"{dev_id}__{k}"] = v
            merged.append(row)
        return merged

    def insert_command(
        self,
        correlation_id: str,
        device_id: str,
        component: str,
        action: str,
        payload: dict[str, Any] | None,
        source: str,
    ) -> None:
        now = utc_now()
        payload_json = json.dumps(payload or {})
        with self._lock, self._conn() as conn:
            conn.execute("""
                INSERT INTO commands (correlation_id, ts, device_id, component, action, payload_json, source, status, sent_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'SENT', ?)
            """, (correlation_id, now, device_id, component, action, payload_json, source, now))

    def ack_command(self, correlation_id: str, ack_payload: dict[str, Any] | None = None) -> bool:
        now = utc_now()
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE commands SET status = 'ACKED', acked_at = ? WHERE correlation_id = ? AND status = 'SENT'",
                (now, correlation_id)
            )
            return cur.rowcount > 0

    def timeout_command(self, correlation_id: str) -> bool:
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE commands SET status = 'TIMEOUT' WHERE correlation_id = ? AND status = 'SENT'",
                (correlation_id,)
            )
            return cur.rowcount > 0

    def timeout_stale_commands(self, older_than_seconds: int) -> int:
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=older_than_seconds)).isoformat()
        with self._lock, self._conn() as conn:
            cur = conn.execute(
                "UPDATE commands SET status = 'TIMEOUT' WHERE status = 'SENT' AND sent_at < ?",
                (cutoff,)
            )
            return cur.rowcount

    def get_command(self, correlation_id: str) -> dict[str, Any] | None:
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM commands WHERE correlation_id = ?", (correlation_id,)
            ).fetchone()
            if not row:
                return None
            payload = {}
            if row["payload_json"]:
                try:
                    payload = json.loads(row["payload_json"])
                except json.JSONDecodeError:
                    pass
            return {
                "correlation_id": row["correlation_id"],
                "device_id": row["device_id"],
                "component": row["component"],
                "action": row["action"],
                "payload": payload,
                "source": row["source"],
                "status": row["status"],
                "sent_at": row["sent_at"],
                "acked_at": row["acked_at"],
                "error": row["error"],
            }

    def insert_ack(self, device_id: str, component: str, correlation_id: str | None, payload: dict[str, Any]) -> None:
        now = utc_now()
        with self._lock, self._conn() as conn:
            conn.execute("""
                INSERT INTO acks (ts, device_id, component, correlation_id, payload_json)
                VALUES (?, ?, ?, ?, ?)
            """, (now, device_id, component, correlation_id, json.dumps(payload)))

    def get_recent_commands(self, device_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock, self._conn() as conn:
            if device_id:
                rows = conn.execute(
                    "SELECT * FROM commands WHERE device_id = ? ORDER BY sent_at DESC LIMIT ?",
                    (device_id, limit)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM commands ORDER BY sent_at DESC LIMIT ?", (limit,)
                ).fetchall()
            result = []
            for r in rows:
                payload = {}
                if r["payload_json"]:
                    try:
                        payload = json.loads(r["payload_json"])
                    except json.JSONDecodeError:
                        pass
                result.append({
                    "correlation_id": r["correlation_id"],
                    "device_id": r["device_id"],
                    "component": r["component"],
                    "action": r["action"],
                    "payload": payload,
                    "source": r["source"],
                    "status": r["status"],
                    "sent_at": r["sent_at"],
                    "acked_at": r["acked_at"],
                })
            return result

    def purge_old_telemetry(self, retain_days: int) -> int:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=retain_days)).isoformat()
        with self._lock, self._conn() as conn:
            cur = conn.execute("DELETE FROM telemetry WHERE ts < ?", (cutoff,))
            return cur.rowcount


def _float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _bool(v: Any) -> bool | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        return v.strip().lower() in ("true", "1", "on", "ok")
    return None


def _sql_bool(v: bool | None) -> int | None:
    if v is None:
        return None
    return 1 if v else 0


def _row_to_telemetry(row: sqlite3.Row) -> dict[str, Any]:
    keys = row.keys()
    return {
        "ts": row["ts"],
        "device_id": row["device_id"],
        "temp": row["temp"],
        "lux": row["lux"],
        "humidity": row["humidity"] if "humidity" in keys else None,
        "water_ok": row["water_ok"] is not None and bool(row["water_ok"]) if "water_ok" in keys else None,
        "heater_on": row["heater_on"] is not None and bool(row["heater_on"]) if "heater_on" in keys else None,
        "water_voltage": row["water_voltage"],
        "button_voltage": row["button_voltage"],
        "button_pressed": row["button_pressed"] is not None and bool(row["button_pressed"]) if "button_pressed" in keys else None,
        "led_on": bool(row["led_on"]) if "led_on" in keys and row["led_on"] is not None else None,
        "led_brightness": row["led_brightness"] if "led_brightness" in keys else None,
        "filter_ble_connected": bool(row["filter_ble_connected"]) if "filter_ble_connected" in keys and row["filter_ble_connected"] is not None else None,
        "filter_power": bool(row["filter_power"]) if "filter_power" in keys and row["filter_power"] is not None else None,
        "filter_mode": row["filter_mode"] if "filter_mode" in keys else None,
        "filter_state_blob_hex": row["filter_state_blob_hex"] if "filter_state_blob_hex" in keys else None,
        "filter_ble_error": row["filter_ble_error"] if "filter_ble_error" in keys else None,
        "filter_last_address": row["filter_last_address"] if "filter_last_address" in keys else None,
    }


def _schedule_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    keys = row.keys()
    curve_points = None
    if "curve_points" in keys and row["curve_points"]:
        try:
            curve_points = json.loads(row["curve_points"])
        except (json.JSONDecodeError, TypeError):
            pass
    return {
        "id": row["id"],
        "device_id": row["device_id"],
        "name": row["name"],
        "enabled": bool(row["enabled"]),
        "scenario_type": row["scenario_type"],
        "dawn_time": row["dawn_time"],
        "dusk_time": row["dusk_time"],
        "dawn_duration_minutes": row["dawn_duration_minutes"],
        "dusk_duration_minutes": row["dusk_duration_minutes"],
        "target_brightness": row["target_brightness"],
        "days_of_week": row["days_of_week"],
        "curve_points": curve_points,
        "created_at": row["created_at"],
    }


def _user_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    keys = row.keys()
    out: dict[str, Any] = {
        "id": row["id"],
        "username": row["username"],
        "is_admin": bool(row["is_admin"]),
        "created_at": row["created_at"],
    }
    if "password_hash" in keys and row["password_hash"]:
        out["password_hash"] = row["password_hash"]
    return out


db = Database()
