#!/usr/bin/env python3
"""Create default admin user (admin/admin). Run from project root: python scripts/create_admin_user.py
Uses AQUA_DATA_DIR for DB path (same as the app)."""

import os
import sys

# Run from repo root so backend modules are importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database import db

USERNAME = "admin"
PASSWORD = "admin"


def _hash_password(password: str) -> str:
    """Bcrypt hash compatible with passlib (used by the app)."""
    try:
        import bcrypt
        return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")
    except ImportError:
        from auth import hash_password
        return hash_password(password)


def main() -> None:
    db.init()
    existing = db.get_user_by_username(USERNAME)
    if existing:
        print(f"User '{USERNAME}' already exists (id={existing['id']}). Nothing done.")
        return
    user = db.create_user(USERNAME, _hash_password(PASSWORD), is_admin=True)
    print(f"Created user '{USERNAME}' (id={user['id']}) with password '{PASSWORD}'.")
    print("Change the password after first login (Settings -> Users or re-run with different password).")


if __name__ == "__main__":
    main()
