# AQUA – Setup guide

This guide walks you through installing and running AQUA: prerequisites, local development, Docker, Portainer, and MQTT over TLS for internet-facing devices.

---

## Prerequisites

### For local development

- **Python 3.10+** (3.12 recommended)
- **Node.js 18+** and npm (for the frontend)
- **Mosquitto** (MQTT broker) – [download](https://mosquitto.org/download/) or install via package manager:
  - Windows: install from [Eclipse Mosquitto](https://mosquitto.org/download/) or `winget install Mosquitto`
  - macOS: `brew install mosquitto`
  - Linux: `sudo apt install mosquitto` / `sudo dnf install mosquitto`

### For Docker

- **Docker** and **Docker Compose** (v2)
- Optional: **Portainer** for web-based stack management

### For ESP32

- **Arduino IDE** or **PlatformIO**, with ESP32 board support
- Libraries: PubSubClient, ArduinoJson, OneWire, DallasTemperature, BH1750, U8g2 (see [ESP32 guide](ESP32.md))

---

## 1. Local development setup

### Step 1: Clone or download the project

```bash
git clone https://github.com/Adri17911/aquaman.git
cd aquaman
```

(Or use your existing `Backend 3.0` folder.)

### Step 2: Install and run Mosquitto

- Start the broker so it listens on **1883** (default).
- Windows: run `mosquitto -v` from the Mosquitto install directory, or run it as a service.
- Linux/macOS: `mosquitto -v` or `brew services start mosquitto` / `sudo systemctl start mosquitto`.

Confirm it’s listening: `netstat -an | findstr 1883` (Windows) or `ss -tlnp | grep 1883` (Linux).

### Step 3: Backend (API + MQTT worker)

```bash
# Create a virtual environment (recommended)
python -m venv .venv
.venv\Scripts\activate   # Windows
# source .venv/bin/activate   # Linux/macOS

pip install -r requirements.txt
```

On first run, the app creates `settings.json` in the project root. Set the MQTT broker:

- Edit `settings.json` and set `mqtt.broker_host` to the IP of the machine running Mosquitto (e.g. `192.168.1.100` or `localhost` if broker is on the same machine).
- Or use the dashboard **Settings** after the app is running.

Start the backend:

```bash
uvicorn main:app --host 0.0.0.0 --port 8080
```

You should see logs like: `MQTT connecting to mqtt://192.168.1.100:1883` and `Application startup complete`.

### Step 4: Frontend (development server)

In a **second terminal**:

```bash
cd frontend
npm install
npm run dev
```

- Open **http://localhost:5173**. The Vite dev server proxies `/api` to the backend (port 8080).
- You can also open **http://localhost:8080** after building the frontend (see Step 5).

### Step 5: Production build (single server)

To serve the dashboard from the backend (no separate Vite process):

```bash
cd frontend
npm install
npm run build
cd ..
uvicorn main:app --host 0.0.0.0 --port 8080
```

Open **http://localhost:8080**. The API is at **http://localhost:8080/api**.

### Step 6: Configure the dashboard

1. Open the dashboard (5173 or 8080).
2. Go to **Settings** (gear icon).
3. Set **Broker host** to your Mosquitto IP and **Port** to 1883.
4. Add a device manually (e.g. `esp32-01`) if your ESP32 isn’t discovered yet.
5. Flash your ESP32 with the same `device_id` and MQTT broker (see [ESP32 guide](ESP32.md)).

---

## 2. Docker setup

### Quick start

From the project root (where `docker-compose.yml` is):

```bash
docker compose up -d
```

- **Dashboard:** http://localhost:8080  
- **API:** http://localhost:8080/api  
- **MQTT (plain):** localhost:1883  
- **MQTT (TLS):** localhost:8883 (enable in Mosquitto config; see [DOCKER.md](../DOCKER.md))

Data is stored in Docker volumes `aqua_data` (DB + settings) and `mosquitto_data`.

### Build only (no compose)

```bash
docker build -t aqua-backend .
docker run -p 8080:8080 -v aqua_data:/data -e AQUA_DATA_DIR=/data -e AQUA_MQTT_BROKER_HOST=host.docker.internal aqua-backend
```

Use `host.docker.internal` if Mosquitto runs on the host (Windows/Mac). On Linux, use the host’s IP.

---

## 3. Portainer deployment

Portainer lets you deploy the stack from Git or from a pre-built image.

### Option A: Deploy from Git (recommended)

1. Push this repo to GitHub (e.g. `https://github.com/Adri17911/aquaman`).
2. In Portainer: **Stacks** → **Add stack**.
3. Name the stack (e.g. `aqua`).
4. **Build method:** Git repository  
   - **Repository URL:** `https://github.com/Adri17911/aquaman.git`  
   - **Repository reference:** `main`  
   - **Compose path:** `docker-compose.yml`
5. Click **Deploy the stack**.
6. Open **http://\<your-server-IP\>:8080**. For MQTT, use **\<your-server-IP\>:1883** (and 8883 if TLS is enabled).

### Option B: Deploy from a pre-built image

1. Build and push the image to a registry:
   ```bash
   docker build -t your-registry.com/aqua-backend:latest .
   docker push your-registry.com/aqua-backend:latest
   ```
2. In Portainer, add a stack with the **Web editor** and use a compose that references `image: your-registry.com/aqua-backend:latest` (no `build:`). See [DOCKER.md](../DOCKER.md) for the compose snippet.

### Tips

- Ensure firewall allows **8080** (HTTP) and **1883** / **8883** (MQTT) if devices are on another network.
- To use a broker already running on the host, remove the `mosquitto` service from the stack and set `AQUA_MQTT_BROKER_HOST: host.docker.internal` for the `aqua` service.

---

## 4. MQTT over TLS (MQTTs) for internet-facing devices

To allow ESP32s (or other clients) to connect over the internet securely:

### 4.1 Device connection API

ESP32s can discover broker settings without hardcoding:

- **Endpoint:** `GET /api/mqtt/connection`
- **Example:** `https://your-server.com/api/mqtt/connection`
- **Response:** `{ "enabled": true, "broker_host": "mqtt.yourdomain.com", "broker_port": 8883, "use_tls": true, "topic_root": "aqua" }`  
  (No credentials; use for device configuration.)

### 4.2 Enable TLS in the app

In the dashboard **Settings** → **MQTT broker** → **Internet (MQTTs)**:

- **Use TLS (MQTTs):** On (if the backend also connects to the broker over TLS).
- **Public broker host:** The hostname or IP devices will use (e.g. `mqtt.yourdomain.com` or your server’s public IP).
- **Public broker port:** `8883`.
- **TLS insecure:** On only if using a self-signed certificate and you want to skip hostname verification.

You can also set these via environment variables (see [CONFIGURATION.md](CONFIGURATION.md)).

### 4.3 Enable TLS in Mosquitto (Docker)

1. Create certificates (e.g. Let’s Encrypt or self-signed). Place `server.crt`, `server.key`, and optionally `ca.crt` in a folder (e.g. `mosquitto/certs/`).
2. Copy `mosquitto/mosquitto.conf.example` to `mosquitto/mosquitto.conf`, uncomment the `listener 8883` block and set the cert paths to match your layout (e.g. `/mosquitto/certs/server.crt`).
3. In `docker-compose.yml`, mount config and certs for the `mosquitto` service:
   ```yaml
   volumes:
     - mosquitto_data:/mosquitto/data
     - ./mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf
     - ./mosquitto/certs:/mosquitto/certs:ro
   ```
4. Expose port **8883** (already in the default compose) and open it in the firewall.
5. If the backend runs in the same Docker network and uses plain MQTT to Mosquitto on 1883, you only need the **public** host/port (8883) for devices. If the backend should also use TLS, set `AQUA_MQTT_USE_TLS=true` and `AQUA_MQTT_BROKER_PORT=8883`.

### 4.4 ESP32 with MQTTs

- Use **WiFiClientSecure** (or your platform’s TLS client) and connect to `broker_host:8883`.
- Optionally call `GET /api/mqtt/connection` over HTTPS first to get `broker_host`, `broker_port`, and `use_tls` dynamically.
- For self-signed certs, you may need to set the CA or use an “insecure” option in the MQTT client. See [ESP32.md](ESP32.md) for firmware notes.

---

## 5. Next steps

- [ESP32 guide](ESP32.md) – wiring, firmware config, MQTT/MQTTs
- [API reference](API.md) – all endpoints
- [Configuration](CONFIGURATION.md) – settings.json and env vars
- [Troubleshooting](TROUBLESHOOTING.md) – common issues
