# ─── Stage 1: Builder ────────────────────────────────────────
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
COPY tsconfig.frontend.json ./

RUN npm ci

# Backend
COPY server.ts ./
COPY db.ts ./

# Frontend
COPY public/ ./public/

# Kompiluje backend (→ dist/) i frontend (app.ts → public/app.js)
RUN npm run build

# ─── Stage 2: Production ─────────────────────────────────────
FROM node:20-alpine AS production

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev && apk del python3 make g++

# Skompilowany backend
COPY --from=builder /app/dist ./dist

# Frontend ze skompilowanym app.js (wygenerowanym z app.ts)
COPY --from=builder /app/public ./public

RUN mkdir -p /app/data /app/uploads

EXPOSE 3000

CMD ["node", "dist/server.js"]