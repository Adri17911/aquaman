"""Auth helpers: JWT and password hashing."""

from __future__ import annotations

import logging
import time
from typing import Any

import bcrypt
import jwt

from config import load_config

logger = logging.getLogger("auth")

# Bcrypt has a 72-byte limit; truncate so long passwords don't raise
BCRYPT_MAX_PASSWORD_BYTES = 72


def _truncate_password(password: str) -> bytes:
    return password.encode("utf-8")[:BCRYPT_MAX_PASSWORD_BYTES]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_truncate_password(password), bcrypt.gensalt()).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(_truncate_password(plain), hashed.encode("ascii"))


def create_access_token(user_id: int, username: str, is_admin: bool) -> str:
    cfg = load_config()
    now = int(time.time())
    expire = now + cfg.auth.jwt_expire_hours * 3600
    payload = {"sub": user_id, "username": username, "is_admin": is_admin, "exp": expire, "iat": now}
    raw = jwt.encode(payload, cfg.auth.jwt_secret, algorithm="HS256")
    return raw if isinstance(raw, str) else raw.decode("utf-8")


def decode_access_token(token: str) -> dict[str, Any] | None:
    try:
        cfg = load_config()
        return jwt.decode(token, cfg.auth.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError as e:
        logger.warning("JWT decode failed: %s", e)
        return None
