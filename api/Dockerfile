FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
# SQL migration files are not compiled by tsc; copy them explicitly so the
# in-process runner (src/db/migrate.ts) can find them at runtime.
COPY --from=builder /app/src/db/migrations ./dist/db/migrations
EXPOSE 8080
USER node
CMD ["node", "dist/server.js"]
