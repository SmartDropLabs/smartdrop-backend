# --- Base & Development Stage ---
FROM node:20-alpine AS development
# Issue #494 — all instants are UTC; pin the container default explicitly so
# log rotation filenames and any date the runtime formats are UTC too.
ENV TZ=UTC
WORKDIR /app

# Instalar dependencias completas (incluye devDependencies para nodemon/hot-reload)
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copiar el código fuente
COPY . .

EXPOSE 4000
CMD ["npm", "run", "dev"]

# --- Builder Stage para Producción ---
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY openapi.yaml ./
COPY public ./public

# --- Production Stage ---
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
# Issue #494 — UTC process default (see development stage above).
ENV TZ=UTC

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/openapi.yaml ./
COPY --from=builder /app/public ./public
COPY package*.json ./

EXPOSE 4000
CMD ["node", "src/index.js"]