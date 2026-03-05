# Running AQUA in Docker

For full setup guides (local, Docker, Portainer, MQTTs), see [docs/SETUP.md](docs/SETUP.md). For configuration and troubleshooting, see [docs/CONFIGURATION.md](docs/CONFIGURATION.md) and [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

---

## Deploy with Portainer

Portainer runs your app as a **Stack** (Docker Compose). Two ways to get the image into Portainer:

### Option A: Stack from Git (recommended)

1. Push this project to a Git repo (GitHub, GitLab, or your own). Ensure the repo has `Dockerfile`, `docker-compose.yml`, `requirements.txt`, and the `frontend/` folder.
2. In Portainer: **Stacks** → **Add stack**.
3. Name the stack (e.g. `aqua`).
4. Under **Build method** choose **Git repository**.
   - **Repository URL:** your repo URL (e.g. `https://github.com/you/aqua-backend.git`).
   - **Repository reference:** branch or tag (e.g. `main`).
   - **Compose path:** `docker-compose.yml` (or the path to it inside the repo).
   - **Build context:** leave as repo root (where `Dockerfile` and `frontend/` live).
5. Click **Deploy the stack**. Portainer will clone the repo, build the image, and start the stack.
6. Open the app at **http://\<your-server\>:8080**. MQTT for ESP32: **\<your-server\>:1883**.

If your compose is in a subfolder (e.g. `Backend 3.0/docker-compose.yml`), set **Compose path** to that path and ensure the **Dockerfile** and **Build context** point to the same folder (e.g. **Build context:** `Backend 3.0`).

### Option B: Build image locally, then use in Portainer

1. On your machine (where the code is), build and push to a registry Portainer can pull from:
   ```bash
   cd "Backend 3.0"
   docker build -t your-registry.com/aqua-backend:latest .
   docker push your-registry.com/aqua-backend:latest
   ```
2. In Portainer: **Stacks** → **Add stack**.
3. Name the stack (e.g. `aqua`).
4. Choose **Web editor** and paste the compose below (replace the image name).
5. Deploy. Portainer will pull the image and start the stack.

**Compose for Option B** (no `build:`, use your image):

```yaml
services:
  aqua:
    image: your-registry.com/aqua-backend:latest
    ports:
      - "8080:8080"
    environment:
      AQUA_DATA_DIR: /data
      AQUA_MQTT_BROKER_HOST: mosquitto
      AQUA_MQTT_BROKER_PORT: "1883"
    volumes:
      - aqua_data:/data
    depends_on:
      - mosquitto
    restart: unless-stopped

  mosquitto:
    image: eclipse-mosquitto:2
    ports:
      - "1883:1883"
    volumes:
      - mosquitto_data:/mosquitto/data
    restart: unless-stopped

volumes:
  aqua_data:
  mosquitto_data:
```

### Portainer tips

- **Access from LAN:** Use the host’s IP (e.g. `http://192.168.1.10:8080`). Ensure ports 8080 and 1883 are not blocked by firewall.
- **MQTT broker on the host:** If Mosquitto runs on the same machine as Portainer, remove the `mosquitto` service and `depends_on`, and set `AQUA_MQTT_BROKER_HOST: host.docker.internal` (or on Linux the host’s IP).
- **Data:** Stacks use Docker volumes `aqua_data` and `mosquitto_data`. To backup, use Portainer **Volumes** → select volume → **Backup**, or backup the host path where the volume is stored.

---

## Quick start (app + MQTT broker in Docker)

From the `Backend 3.0` directory:

```bash
docker compose up -d
```

- **Dashboard:** http://localhost:8080  
- **API:** http://localhost:8080/api  
- **MQTT broker:** `localhost:1883` (for ESP32 / external clients)

Data (SQLite DB and settings) is stored in the `aqua_data` volume.

## Data persistence (survives redeploy and ESP disconnect)

The app **records every telemetry value** (temp, lux, water, heater, LED, etc.) in a SQLite database. This data is stored on the **`aqua_data`** volume, so it:

- **Survives app redeploy** – `docker compose up -d --build` or restarting the stack keeps the database; the volume is not recreated.
- **Survives ESP32 unplug** – When the ESP is disconnected, no new data is received, but all **historical data stays** in the DB. When the ESP reconnects, new points are appended.

To avoid losing data when stopping the stack, **do not** use `docker compose down -v` (the `-v` flag removes volumes). Use `docker compose down` so the `aqua_data` volume is kept.

By default, telemetry older than 30 days is purged to limit DB size. To keep data longer or forever, set `AQUA_RETAIN_DAYS` (e.g. `365` for one year, or `0` to keep all data indefinitely). See the environment variables table below.

## Using an existing MQTT broker on the host

If Mosquitto (or another broker) runs on the host:

1. In `docker-compose.yml`, remove the `mosquitto` service and the `depends_on: - mosquitto` from `aqua`.
2. Set environment for `aqua`:
   - **Windows/Mac:** `AQUA_MQTT_BROKER_HOST: host.docker.internal`
   - **Linux:** use your host IP or run compose with `network_mode: host` and `broker_host: localhost`

Then run:

```bash
docker compose up -d
```

## Build image only (no compose)

```bash
docker build -t aqua-backend .
docker run -p 8080:8080 -v aqua_data:/data -e AQUA_DATA_DIR=/data -e AQUA_MQTT_BROKER_HOST=host.docker.internal aqua-backend
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `AQUA_DATA_DIR` | Directory for `aqua.db` and `settings.json` (default: app dir). Set to `/data` in Docker. |
| `AQUA_RETAIN_DAYS` | Telemetry retention in days (0 = keep forever, 1–3650 = purge older). Default from settings (30). |
| `AQUA_MQTT_BROKER_HOST` | Override MQTT broker host from settings. |
| `AQUA_MQTT_BROKER_PORT` | Override MQTT broker port. |
| `AQUA_MQTT_USE_TLS` | Set to `1` or `true` to connect to the broker with MQTT over TLS. |
| `AQUA_MQTT_CA_CERTS` | Path to CA certificate file (optional). |
| `AQUA_MQTT_TLS_INSECURE` | Set to `1` or `true` to skip server hostname verification (e.g. self-signed certs). |
| `AQUA_MQTT_PUBLIC_BROKER_HOST` | Hostname returned to devices (e.g. your domain); for `GET /api/mqtt/connection`. |
| `AQUA_MQTT_PUBLIC_BROKER_PORT` | Port returned to devices (e.g. `8883` for MQTTs). |

---

## MQTT over TLS (MQTTs) for internet-facing devices

To let ESP32s (or other devices) connect over the internet securely:

1. **Device connection API**  
   ESP32s can call **`GET /api/mqtt/connection`** to get broker host, port, `use_tls`, and `topic_root` (no credentials). Use your server’s public URL, e.g. `https://your-server.com/api/mqtt/connection`.

2. **Enable TLS in the app**  
   In the dashboard **Settings** (or via env):
   - **Use TLS:** on  
   - **Public broker host:** your domain or public IP (e.g. `mqtt.yourdomain.com` or the same host as the API)  
   - **Public broker port:** `8883`  
   - If using a self-signed certificate, enable **TLS insecure** (skip hostname verification).

3. **Enable TLS in Mosquitto**  
   - Create certs (e.g. Let’s Encrypt or self-signed) and put `server.crt`, `server.key`, and optionally `ca.crt` in `mosquitto/certs/`.  
   - Copy `mosquitto/mosquitto.conf.example` to `mosquitto/mosquitto.conf`, uncomment the `listener 8883` block and set the cert paths.  
   - In `docker-compose.yml`, mount config and certs for the `mosquitto` service:
     ```yaml
     volumes:
       - mosquitto_data:/mosquitto/data
       - ./mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf
       - ./mosquitto/certs:/mosquitto/certs:ro
     ```
   - Ensure port **8883** is exposed and reachable (firewall, router).

4. **Backend connecting with TLS**  
   If the broker is in the same stack, backend can still use `AQUA_MQTT_BROKER_HOST=mosquitto` and `AQUA_MQTT_BROKER_PORT=1883` (plain) for in-network traffic, while devices use the public host:8883 with MQTTs. Or set `AQUA_MQTT_USE_TLS=true` and `AQUA_MQTT_BROKER_PORT=8883` if the backend also talks to the broker over TLS.

5. **ESP32 firmware**  
   Use `WiFiClientSecure` and connect to the host/port from `/api/mqtt/connection` with TLS (port 8883). For self-signed certs you may need to set the CA or skip verification in the ESP32 MQTT client.
