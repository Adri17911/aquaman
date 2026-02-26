"""Aquarium Automation Platform - API server."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from config import load_config, save_config
from database import db
from events import emit_event, sse_response
from mqtt_worker import mqtt_worker
from scheduler import run_dawn_dusk_tick

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger("aqua-api")

FRONTEND_DIR = Path(__file__).resolve().parent / "frontend" / "dist"
COMMAND_TIMEOUT_CHECK_INTERVAL = 1.0


# --- Pydantic models ---
class HeaterCommand(BaseModel):
    action: str = Field(pattern="^(on|off|toggle)$")


class LedCommand(BaseModel):
    action: str = Field(pattern="^(on|off|toggle|set_brightness)$")
    payload: dict | None = None


class CommandRequest(BaseModel):
    action: str
    payload: dict | None = None


class AddDeviceRequest(BaseModel):
    device_id: str
    name: str | None = None


class MqttSettingsUpdate(BaseModel):
    broker_host: str | None = None
    broker_port: int | None = Field(None, ge=1, le=65535)
    username: str | None = None
    password: str | None = None


class ScheduleCreate(BaseModel):
    device_id: str
    name: str
    scenario_type: str = "dawn_dusk"
    dawn_time: str = "07:00"
    dusk_time: str = "21:00"
    dawn_duration_minutes: int = Field(30, ge=1, le=120)
    dusk_duration_minutes: int = Field(30, ge=1, le=120)
    target_brightness: int = Field(100, ge=0, le=100)
    days_of_week: str = "0,1,2,3,4,5,6"
    enabled: bool = True
    curve_points: str | None = None


class ScheduleUpdate(BaseModel):
    name: str | None = None
    scenario_type: str | None = None
    dawn_time: str | None = None
    dusk_time: str | None = None
    dawn_duration_minutes: int | None = Field(None, ge=1, le=120)
    dusk_duration_minutes: int | None = Field(None, ge=1, le=120)
    target_brightness: int | None = Field(None, ge=0, le=100)
    days_of_week: str | None = None
    enabled: bool | None = None
    curve_points: str | None = None


# --- Background tasks ---
async def command_timeout_loop():
    """Mark commands as TIMEOUT when no ack received within configured seconds."""
    while True:
        try:
            await asyncio.sleep(COMMAND_TIMEOUT_CHECK_INTERVAL)
            cfg = load_config()
            n = db.timeout_stale_commands(cfg.mqtt.command_timeout_seconds)
            if n:
                logger.info("Timed out %d pending command(s)", n)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.exception("Command timeout loop error: %s", e)


async def housekeeping_loop():
    """Purge old telemetry periodically."""
    while True:
        try:
            await asyncio.sleep(60)
            cfg = load_config()
            purged = db.purge_old_telemetry(cfg.logging.retain_days)
            if purged:
                logger.info("Purged %d old telemetry rows", purged)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.exception("Housekeeping error: %s", e)


async def scheduler_loop():
    """Run dawn/dusk scheduler every minute."""
    while True:
        try:
            await asyncio.sleep(60)
            run_dawn_dusk_tick()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.exception("Scheduler error: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    mqtt_worker.start()
    timeout_task = asyncio.create_task(command_timeout_loop())
    housekeeping_task = asyncio.create_task(housekeeping_loop())
    scheduler_task = asyncio.create_task(scheduler_loop())
    try:
        yield
    finally:
        timeout_task.cancel()
        housekeeping_task.cancel()
        scheduler_task.cancel()
        try:
            await asyncio.gather(timeout_task, housekeeping_task, scheduler_task)
        except asyncio.CancelledError:
            pass
        mqtt_worker.stop()


app = FastAPI(
    title="Aquarium Automation Platform",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- API (mounted at /api so catch-all doesn't shadow PUT/POST) ---
api = FastAPI()


@api.get("/health")
def health():
    cfg = load_config()
    latest = db.get_latest_telemetry()
    return {
        "status": "ok",
        "mqtt_connected": mqtt_worker.connected,
        "mqtt_broker": f"{cfg.mqtt.broker_host}:{cfg.mqtt.broker_port}" if cfg.mqtt.enabled else None,
        "devices_count": len(db.list_devices()),
        "latest_telemetry_ts": latest["ts"] if latest else None,
    }


@api.get("/devices")
def list_devices():
    return db.list_devices()


@api.post("/devices")
def add_device(body: AddDeviceRequest):
    device_id = (body.device_id or "").strip()
    if not device_id:
        raise HTTPException(400, "device_id is required")
    db.add_device_manual(device_id, body.name)
    dev = db.get_device(device_id)
    return {"device": dev, "status": "added"}


@api.get("/devices/{device_id}")
def get_device(device_id: str):
    dev = db.get_device(device_id)
    if not dev:
        raise HTTPException(404, f"Device {device_id} not found")
    latest = db.get_latest_telemetry(device_id)
    return {"device": dev, "latest_telemetry": latest}


@api.get("/telemetry/latest")
def get_latest_telemetry(device_id: str | None = Query(None)):
    latest = db.get_latest_telemetry(device_id)
    if not latest:
        raise HTTPException(404, "No telemetry yet")
    return latest


@api.get("/telemetry/log")
def get_telemetry_log(
    device_id: str = Query(...),
    limit: int = Query(100, ge=1, le=500),
):
    rows = db.get_telemetry_log(device_id, limit)
    return {"device_id": device_id, "rows": rows}


@api.get("/telemetry")
def get_telemetry_series(
    device_id: str = Query(...),
    metric: str = Query("temp"),
    metrics: str | None = Query(None),
    from_ts: str | None = Query(None),
    to_ts: str | None = Query(None),
    bucket: str | None = Query(None),
    agg: str = Query("last"),
    limit: int = Query(1000, ge=1, le=10000),
):
    if metrics:
        ml = [m.strip() for m in metrics.split(",") if m.strip()]
        rows = db.get_telemetry_multi(device_id, ml, from_ts, to_ts, limit)
        return {"device_id": device_id, "metrics": ml, "points": rows}
    points = db.get_telemetry_series(device_id, metric, from_ts, to_ts, bucket, agg, limit)
    return {"device_id": device_id, "metric": metric, "points": points}


@api.post("/devices/{device_id}/commands/heater")
def heater_command(device_id: str, body: CommandRequest):
    if not db.device_online(device_id):
        raise HTTPException(409, "Device offline - command rejected")
    try:
        corr_id = mqtt_worker.publish_command(device_id, "heater", body.action, body.payload, "ui")
        return {"correlation_id": corr_id, "status": "sent"}
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@api.post("/devices/{device_id}/commands/led")
def led_command(device_id: str, body: CommandRequest):
    if not db.device_online(device_id):
        raise HTTPException(409, "Device offline - command rejected")
    try:
        corr_id = mqtt_worker.publish_command(device_id, "led", body.action, body.payload, "ui")
        return {"correlation_id": corr_id, "status": "sent"}
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@api.get("/commands/{correlation_id}")
def get_command_status(correlation_id: str):
    cmd = db.get_command(correlation_id)
    if not cmd:
        raise HTTPException(404, "Command not found")
    return cmd


@api.get("/commands")
def list_commands(device_id: str | None = Query(None), limit: int = Query(50, ge=1, le=200)):
    return db.get_recent_commands(device_id, limit)


@api.get("/stream")
async def stream():
    """SSE stream for live telemetry, status, and command acks."""
    return sse_response()


@api.get("/settings/mqtt")
def get_mqtt_settings():
    cfg = load_config()
    m = cfg.mqtt
    return {
        "broker_host": m.broker_host,
        "broker_port": m.broker_port,
        "username": m.username or "",
        "has_password": m.password is not None and len(str(m.password)) > 0,
    }


def _do_update_mqtt_settings(body: MqttSettingsUpdate):
    cfg = load_config()
    m = cfg.mqtt
    if body.broker_host is not None:
        m = m.model_copy(update={"broker_host": body.broker_host.strip() or "localhost"})
    if body.broker_port is not None:
        m = m.model_copy(update={"broker_port": body.broker_port})
    if body.username is not None:
        m = m.model_copy(update={"username": body.username.strip() or None})
    if body.password is not None:
        m = m.model_copy(update={"password": body.password if body.password else None})
    cfg = cfg.model_copy(update={"mqtt": m})
    save_config(cfg)
    mqtt_worker.stop()
    mqtt_worker.start()
    return get_mqtt_settings()


@api.put("/settings/mqtt")
@api.post("/settings/mqtt")
def update_mqtt_settings(body: MqttSettingsUpdate):
    return _do_update_mqtt_settings(body)


@api.get("/schedules")
def list_schedules(device_id: str | None = Query(None)):
    return db.list_schedules(device_id)


@api.post("/schedules")
def create_schedule(body: ScheduleCreate):
    s = db.create_schedule(
        device_id=body.device_id,
        name=body.name,
        scenario_type=body.scenario_type,
        dawn_time=body.dawn_time,
        dusk_time=body.dusk_time,
        dawn_duration_minutes=body.dawn_duration_minutes,
        dusk_duration_minutes=body.dusk_duration_minutes,
        target_brightness=body.target_brightness,
        days_of_week=body.days_of_week,
        enabled=body.enabled,
        curve_points=body.curve_points,
    )
    return s


@api.get("/schedules/{schedule_id}")
def get_schedule(schedule_id: int):
    s = db.get_schedule(schedule_id)
    if not s:
        raise HTTPException(404, "Schedule not found")
    return s


@api.put("/schedules/{schedule_id}")
def update_schedule(schedule_id: int, body: ScheduleUpdate):
    from database import _UNSET
    provided = body.model_dump(exclude_unset=True)
    curve_pts = provided.pop("curve_points", _UNSET)
    if "scenario_type" in provided and provided["scenario_type"] == "dawn_dusk":
        curve_pts = None
    elif curve_pts is _UNSET:
        pass
    s = db.update_schedule(
        schedule_id,
        name=provided.get("name"),
        dawn_time=provided.get("dawn_time"),
        dusk_time=provided.get("dusk_time"),
        dawn_duration_minutes=provided.get("dawn_duration_minutes"),
        dusk_duration_minutes=provided.get("dusk_duration_minutes"),
        target_brightness=provided.get("target_brightness"),
        days_of_week=provided.get("days_of_week"),
        enabled=provided.get("enabled"),
        scenario_type=provided.get("scenario_type"),
        curve_points=curve_pts if curve_pts is not _UNSET else _UNSET,
    )
    if not s:
        raise HTTPException(404, "Schedule not found")
    return s


@api.delete("/schedules/{schedule_id}")
def delete_schedule(schedule_id: int):
    if not db.delete_schedule(schedule_id):
        raise HTTPException(404, "Schedule not found")
    return {"status": "deleted"}


app.mount("/api", api)

# --- Serve frontend ---
# API routes must be registered before the catch-all so PUT/POST to /api/* work
if FRONTEND_DIR.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")

    @app.get("/")
    def serve_index():
        return FileResponse(FRONTEND_DIR / "index.html")

    @app.get("/{path:path}")
    def serve_spa(path: str):
        if (FRONTEND_DIR / path).exists() and (FRONTEND_DIR / path).is_file():
            return FileResponse(FRONTEND_DIR / path)
        return FileResponse(FRONTEND_DIR / "index.html")
else:
    @app.get("/")
    def root():
        return {"message": "Aquarium API running. Build frontend with: cd frontend && npm run build"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=True)
