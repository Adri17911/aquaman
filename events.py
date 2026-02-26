"""Server-Sent Events: in-memory pub/sub for live updates."""

from __future__ import annotations

import asyncio
import json
import logging
import queue
import threading
from typing import Any

from starlette.responses import StreamingResponse

logger = logging.getLogger("events")

_subscribers: set[queue.Queue[dict[str, Any]]] = set()
_lock = threading.Lock()


def _subscribe() -> queue.Queue[dict[str, Any]]:
    q: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=64)
    with _lock:
        _subscribers.add(q)
    return q


def _unsubscribe(q: queue.Queue[dict[str, Any]]) -> None:
    with _lock:
        _subscribers.discard(q)


def emit_event(event_type: str, data: dict[str, Any]) -> None:
    """Emit event to all SSE subscribers. Safe to call from sync (e.g. MQTT callback)."""
    payload = {"type": event_type, **data}
    with _lock:
        subs = list(_subscribers)
    for q in subs:
        try:
            q.put(payload, block=False)
        except queue.Full:
            try:
                q.get_nowait()
                q.put(payload, block=False)
            except Exception:
                pass


async def event_generator():
    q = _subscribe()
    loop = asyncio.get_event_loop()
    try:
        while True:
            msg = await loop.run_in_executor(None, q.get)
            yield f"event: message\ndata: {json.dumps(msg)}\n\n"
    except asyncio.CancelledError:
        pass
    finally:
        _unsubscribe(q)


def sse_response():
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
