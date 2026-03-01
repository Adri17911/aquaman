"""Auth helpers: JWT and password hashing."""

from __future__ import annotations

import time
from typing import Any

import jwt
from passlib.context import CryptContext

from config import load_config

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_ctx.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)


def create_access_token(user_id: int, username: str, is_admin: bool) -> str:
    cfg = load_config()
    now = int(time.time())
    expire = now + cfg.auth.jwt_expire_hours * 3600
    payload = {"sub": user_id, "username": username, "is_admin": is_admin, "exp": expire, "iat": now}
    return jwt.encode(payload, cfg.auth.jwt_secret, algorithm="HS256")


def decode_access_token(token: str) -> dict[str, Any] | None:
    try:
        cfg = load_config()
        return jwt.decode(token, cfg.auth.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
