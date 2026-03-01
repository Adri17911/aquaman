# Build frontend
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Runtime
FROM python:3.12-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py config.py database.py events.py mqtt_worker.py scheduler.py auth.py ./
COPY scripts/ ./scripts/
COPY --from=frontend /app/frontend/dist ./frontend/dist

# Persist DB and settings (mount volume at /data and set AQUA_DATA_DIR)
ENV AQUA_DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
