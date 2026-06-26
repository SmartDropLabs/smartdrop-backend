# --- Base & Development Stage ---
FROM node:20-alpine AS development
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

# --- Production Stage ---
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY package*.json ./

EXPOSE 4000
CMD ["node", "src/index.js"]