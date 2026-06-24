FROM node:20-alpine AS builder

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS production

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

USER node
EXPOSE 3000

CMD ["npm", "start"]
