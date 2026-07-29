# ── Stage 1: Build native modules ──────────────────────────────────────────
FROM node:20-alpine AS builder

# Build tools needed for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
RUN npm install multer

# ── Stage 2: Runtime image ──────────────────────────────────────────────────
FROM node:20-alpine

# FFmpeg for thumbnail generation and video probing
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy compiled node_modules from builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY . .

# Create runtime directories
RUN mkdir -p /app/data/thumbnails

EXPOSE 443

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-check-certificate -qO- https://localhost:443/health || wget -qO- http://localhost:443/health || exit 1

CMD ["node", "server.js"]
