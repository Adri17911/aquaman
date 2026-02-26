"""Configuration for Aquarium Automation Platform."""

from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Lock

from pydantic import BaseModel, Field


_def_dir = Path(__file__).resolve().parent
_data_dir = Path(os.environ.get("AQUA_DATA_DIR", _def_dir))
CONFIG_PATH = _data_dir / "settings.json"
DB_PATH = _data_dir / "aqua.db"


class MqttSettings(BaseModel):
    broker_host: str = "192.168.1.100"
    broker_port: int = Field(default=1883, ge=1, le=65535)
    username: str | None = None
    password: str | None = None
    client_id: str = "aqua-backend"
    topic_root: str = "aqua"
    default_device_id: str = "esp32-01"
    enabled: bool = True
    keepalive_seconds: int = Field(default=60, ge=10, le=600)
    telemetry_qos: int = Field(default=1, ge=0, le=2)
    command_qos: int = Field(default=1, ge=0, le=2)
    command_timeout_seconds: int = Field(default=5, ge=1, le=60)


class LoggingSettings(BaseModel):
    retain_days: int = Field(default=30, ge=1, le=3650)


class AppConfig(BaseModel):
    mqtt: MqttSettings = MqttSettings()
    logging: LoggingSettings = LoggingSettings()


_config_lock = Lock()
_cached_config: AppConfig | None = None


def load_config() -> AppConfig:
    global _cached_config
    with _config_lock:
        if _cached_config is not None:
            return _cached_config
        if CONFIG_PATH.exists():
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            _cached_config = AppConfig(**data)
        else:
            _cached_config = AppConfig()
            CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
            CONFIG_PATH.write_text(_cached_config.model_dump_json(indent=2), encoding="utf-8")
        # Docker/env overrides (do not persist into settings.json)
        if os.environ.get("AQUA_MQTT_BROKER_HOST"):
            _cached_config.mqtt.broker_host = os.environ["AQUA_MQTT_BROKER_HOST"]
        if os.environ.get("AQUA_MQTT_BROKER_PORT"):
            _cached_config.mqtt.broker_port = int(os.environ["AQUA_MQTT_BROKER_PORT"])
        return _cached_config


def save_config(config: AppConfig) -> None:
    global _cached_config
    with _config_lock:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(config.model_dump_json(indent=2), encoding="utf-8")
        _cached_config = config


def reload_config() -> None:
    """Force reload from disk (e.g. after external edit)."""
    global _cached_config
    with _config_lock:
        _cached_config = None
    load_config()
