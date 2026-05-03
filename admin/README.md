# EvoLights Cloud Admin

Operator console for the EvoLights cloud panel. Next.js 15 (App Router,
Server Components, Server Actions). Talks to the api over the internal
docker network; bearer token lives in an HttpOnly cookie that client JS
never sees.

## Local dev

```bash
npm install
API_BASE_URL=http://localhost:8080 npm run dev
# → http://localhost:3000
```

The dev server uses native `fetch` against the `API_BASE_URL` host. To
log in you need an admin user — see `npm run admin:promote` in `../api`.

## Build

```bash
npm run lint     # tsc --noEmit
npm run build    # next build (standalone output)
```

## Container

```bash
docker compose up admin --build
```

## Environment

| Var               | Required | Notes                                                |
|-------------------|----------|------------------------------------------------------|
| `API_BASE_URL`    | yes      | Internal URL of the api (e.g. `http://api:8080`)     |
| `NEXT_PUBLIC_BRAND` | no     | Display name in the navbar; default `EvoLights`      |
| `ADMIN_PORT`      | no       | Port to bind in dev/start scripts; default `3000`    |
| `NODE_ENV`        | no       | Set to `production` to enable Secure cookies         |

The admin app does NOT read API secrets directly. All Stripe / OTA / email
configuration is read by the api process and surfaced (booleans only) via
`/v1/admin/settings`.
