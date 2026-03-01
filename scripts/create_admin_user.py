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
    """Use app's passlib when possible so login always works; fallback to bcrypt."""
    try:
        from auth import hash_password
        return hash_password(password)
    except Exception:
        import bcrypt
        return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def main() -> None:
    db.init()
    existing = db.get_user_by_username(USERNAME)
    if existing:
        # Update password so admin/admin works (e.g. after script was run with wrong hash)
        new_hash = _hash_password(PASSWORD)
        with db._lock, db._conn() as conn:
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE username = ?",
                (new_hash, USERNAME.lower()),
            )
        print(f"User '{USERNAME}' password reset to '{PASSWORD}'.")
        return
    user = db.create_user(USERNAME, _hash_password(PASSWORD), is_admin=True)
    print(f"Created user '{USERNAME}' (id={user['id']}) with password '{PASSWORD}'.")
    print("Change the password after first login (Settings -> Users or re-run with different password).")


if __name__ == "__main__":
    main()
