# EvoLights Cloud

Self-hosted control plane for the EvoLights smart-light platform. Provides:

- **Account auth** (email + password, JWT sessions)
- **Stripe billing** for cloud subscriptions
- **MQTT relay** so the EvoLights mobile app can control WLED-EvoLights firmware running on ESP32 controllers behind home firewalls
- **OTA delivery** of signed firmware updates to paired devices

Designed to run in Docker on a single host (the operator's datacenter).

## Architecture

```
            ┌────────────┐         ┌────────────────────┐
 mobile ───▶│  api       │────────▶│ postgres           │
 app        │  (Fastify) │         │ (accounts, devices)│
            └─────┬──────┘         └────────────────────┘
                  │ publishes cmds
                  ▼
            ┌────────────┐         ┌────────────────────┐
            │ mosquitto  │◀──TLS──▶│ ESP32 (EvoLights)  │
            │ (MQTT)     │  8883   │ outbound only      │
            └────────────┘         └────────────────────┘
```

Containers (see `docker-compose.yml`):

| Service | Image | Purpose |
|---|---|---|
| `api` | built from `./api` (Node/Fastify/TS) | REST API, auth, Stripe webhooks, OTA manifest signing, MQTT publisher |
| `mosquitto` | `eclipse-mosquitto:2` | MQTT broker, TLS on 8883, plain on 1883 (internal only) |
| `postgres` | `postgres:16-alpine` | Accounts, devices, subscriptions, firmware versions |
| `nginx` | `nginx:alpine` | TLS termination + reverse proxy for the API |

## Local development

```bash
cp .env.example .env
# edit .env — fill in STRIPE_SECRET_KEY, JWT_SECRET, etc.

docker compose up -d
docker compose logs -f api
```

API at `http://localhost:8080`. MQTT broker at `mqtt://localhost:1883` (TLS at `mqtts://localhost:8883`).

## Production deployment

Built images are pushed to GHCR by GitHub Actions on every push to `main`:

- `ghcr.io/johnsonflix/evolights-cloud-api:latest`
- `ghcr.io/johnsonflix/evolights-cloud-api:<git-sha>`
- `ghcr.io/johnsonflix/evolights-cloud-api:<tag>` (on releases)

On the production host, pull and restart:

```bash
docker compose pull api
docker compose up -d api
```

A Watchtower container can automate this — see `docs/deploy.md` (TODO).

## Status

Early scaffold. See [`docs/roadmap.md`](docs/roadmap.md) (TODO) for the build plan.
