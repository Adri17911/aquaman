#!/usr/bin/env python3
"""Update MQTT broker settings via API. Usage: python set_mqtt_broker.py [host] [port]"""

import json
import sys
import urllib.request

API = "http://localhost:8080/api/settings/mqtt"

def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.250"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 1883

    data = json.dumps({"broker_host": host, "broker_port": port}).encode()
    req = urllib.request.Request(
        API, data=data, method="PUT",
        headers={"Content-Type": "application/json"}
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            out = json.loads(r.read().decode())
            print(f"OK: broker set to {out['broker_host']}:{out['broker_port']}")
    except urllib.error.HTTPError as e:
        print(f"Error {e.code}: {e.read().decode()}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Failed: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
