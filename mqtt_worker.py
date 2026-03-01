"""MQTT ingestion worker: subscribes to telemetry, status, ack; writes to DB; emits events."""

from __future__ import annotations

import json
import logging
import re
import ssl
import threading
import uuid
from typing import Any, Callable

import paho.mqtt.client as mqtt

from config import load_config
from database import db, utc_now
from events import emit_event

logger = logging.getLogger("mqtt_worker")

TELEMETRY_REQUIRED = {"device_id", "ip"}  # Minimal for device identification; metrics can be null
STATUS_REQUIRED = {"status", "device_id", "ip"}


def _topic_parts(topic: str) -> list[str]:
    return [p for p in topic.strip("/").split("/") if p]


def parse_device_id(topic: str, root: str) -> str | None:
    parts = _topic_parts(topic)
    root_clean = root.strip("/")
    if len(parts) >= 2 and parts[0] == root_clean:
        return parts[1]
    return None


def parse_component_from_ack(topic: str, root: str) -> str | None:
    """Extract component from aqua/{device_id}/ack/{component}"""
    parts = _topic_parts(topic)
    root_clean = root.strip("/")
    if len(parts) >= 4 and parts[0] == root_clean and parts[2] == "ack":
        return parts[3]
    return None


def validate_telemetry(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    missing = TELEMETRY_REQUIRED - set(payload.keys())
    if missing:
        logger.warning("Telemetry missing keys: %s", missing)
        return False
    return True


def validate_status(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    if "status" not in payload:
        return False
    return payload["status"] in ("online", "offline")


class MqttWorker:
    def __init__(self) -> None:
        self._client: mqtt.Client | None = None
        self._connected = False
        self._lock = threading.Lock()
        self._running = False
        self._thread: threading.Thread | None = None

    @property
    def connected(self) -> bool:
        return self._connected

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._connect()
        logger.info("MQTT worker started")

    def stop(self) -> None:
        self._running = False
        with self._lock:
            if self._client:
                try:
                    self._client.loop_stop()
                    self._client.disconnect()
                except Exception:
                    pass
                self._client = None
        self._connected = False
        logger.info("MQTT worker stopped")

    def publish_command(
        self,
        device_id: str,
        component: str,
        action: str,
        payload: dict[str, Any] | None = None,
        source: str = "ui",
    ) -> str:
        """Publish command and return correlation_id."""
        cfg = load_config()
        if not cfg.mqtt.enabled:
            raise RuntimeError("MQTT is disabled")

        correlation_id = str(uuid.uuid4())
        topic = f"{cfg.mqtt.topic_root.strip('/')}/{device_id}/cmd/{component}"
        cmd_payload = {
            "action": action,
            "correlation_id": correlation_id,
            "source": source,
            "ts": utc_now(),
        }
        if payload:
            cmd_payload["payload"] = payload

        db.insert_command(correlation_id, device_id, component, action, payload, source)

        with self._lock:
            if not self._client or not self._connected:
                raise RuntimeError("MQTT client not connected")
            result = self._client.publish(
                topic,
                json.dumps(cmd_payload),
                qos=cfg.mqtt.command_qos,
                retain=False,
            )
            if result.rc != mqtt.MQTT_ERR_SUCCESS:
                raise RuntimeError(f"Publish failed: {result.rc}")

        emit_event("command_sent", {"correlation_id": correlation_id, "device_id": device_id, "component": component})
        return correlation_id

    def _connect(self) -> None:
        cfg = load_config()
        if not cfg.mqtt.enabled:
            logger.info("MQTT disabled")
            return

        with self._lock:
            if self._client:
                try:
                    self._client.loop_stop()
                    self._client.disconnect()
                except Exception:
                    pass
                self._client = None

            client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2, client_id=cfg.mqtt.client_id)
            if cfg.mqtt.username:
                client.username_pw_set(cfg.mqtt.username, cfg.mqtt.password)
            if cfg.mqtt.use_tls:
                cert_reqs = ssl.CERT_NONE if cfg.mqtt.tls_insecure else ssl.CERT_REQUIRED
                client.tls_set(
                    ca_certs=cfg.mqtt.ca_certs or None,
                    cert_reqs=cert_reqs,
                    tls_version=ssl.PROTOCOL_TLS_CLIENT,
                )
                if cfg.mqtt.tls_insecure:
                    client.tls_insecure_set(True)
            client.reconnect_delay_set(min_delay=1, max_delay=30)
            client.on_connect = self._on_connect
            client.on_disconnect = self._on_disconnect
            client.on_message = self._on_message

            root = cfg.mqtt.topic_root.strip("/")
            will_topic = f"{root}/backend/status"
            client.will_set(will_topic, json.dumps({"status": "offline", "source": "backend"}), qos=1, retain=True)
            client.connect_async(cfg.mqtt.broker_host, cfg.mqtt.broker_port, cfg.mqtt.keepalive_seconds)
            client.loop_start()
            self._client = client
        scheme = "mqtts" if cfg.mqtt.use_tls else "mqtt"
        logger.info("MQTT connecting to %s://%s:%s", scheme, cfg.mqtt.broker_host, cfg.mqtt.broker_port)

    def _on_connect(
        self,
        _client: mqtt.Client,
        _userdata: Any,
        _flags: mqtt.ConnectFlags,
        reason_code: mqtt.ReasonCode,
        _properties: Any,
    ) -> None:
        rc = getattr(reason_code, "value", reason_code)
        self._connected = (rc == 0) if isinstance(rc, int) else False
        if not self._connected:
            logger.error("MQTT connect failed: %s", reason_code)
            return

        cfg = load_config()
        root = cfg.mqtt.topic_root.strip("/")
        client = _client

        client.subscribe(f"{root}/+/telemetry", qos=cfg.mqtt.telemetry_qos)
        client.subscribe(f"{root}/+/status", qos=1)
        client.subscribe(f"{root}/+/ack/#", qos=1)

        client.publish(
            f"{root}/backend/status",
            json.dumps({"status": "online", "source": "backend", "ts": utc_now()}),
            qos=1,
            retain=True,
        )
        logger.info("MQTT connected, subscribed to telemetry, status, ack/#")

    def _on_disconnect(
        self,
        _client: mqtt.Client,
        _userdata: Any,
        _flags: mqtt.DisconnectFlags,
        reason_code: mqtt.ReasonCode,
        _properties: Any,
    ) -> None:
        self._connected = False
        logger.warning("MQTT disconnected: %s", reason_code)

    def _on_message(self, _client: mqtt.Client, _userdata: Any, message: mqtt.MQTTMessage) -> None:
        try:
            topic = message.topic
            payload_text = message.payload.decode("utf-8", errors="replace")
            try:
                payload = json.loads(payload_text) if payload_text else {}
            except json.JSONDecodeError:
                logger.warning("Invalid JSON on %s: %s", topic, payload_text[:100])
                return

            cfg = load_config()
            device_id = parse_device_id(topic, cfg.mqtt.topic_root)
            if not device_id:
                return

            if topic.endswith("/status"):
                if validate_status(payload):
                    payload["device_id"] = device_id
                    db.upsert_device_from_status(device_id, str(payload["status"]), payload)
                    emit_event("status", {"device_id": device_id, "status": payload["status"], "payload": payload})
                return

            if "/ack/" in topic:
                component = parse_component_from_ack(topic, cfg.mqtt.topic_root)
                if component:
                    payload["device_id"] = payload.get("device_id", device_id)
                    correlation_id = payload.get("correlation_id")
                    db.insert_ack(device_id, component, correlation_id, payload)
                    if correlation_id:
                        if db.ack_command(correlation_id, payload):
                            emit_event("command_ack", {
                                "correlation_id": correlation_id,
                                "device_id": device_id,
                                "component": component,
                                "payload": payload,
                            })
                    emit_event("ack", {"device_id": device_id, "component": component, "payload": payload})
                return

            if topic.endswith("/telemetry"):
                payload["device_id"] = payload.get("device_id", device_id)
                if validate_telemetry(payload):
                    db.upsert_device_from_telemetry(device_id, payload)
                    db.insert_telemetry(device_id, payload)
                    logger.info("Telemetry %s: temp=%s lux=%s water=%s heater=%s", device_id,
                        payload.get("temp"), payload.get("lux"), payload.get("water"), payload.get("heater"))
                    emit_event("telemetry", {"device_id": device_id, "payload": payload})
        except Exception as e:
            logger.exception("MQTT message error: %s", e)


mqtt_worker = MqttWorker()
