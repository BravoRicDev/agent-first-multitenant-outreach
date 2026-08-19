FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app

# Chromium per headless browser scraping
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    wget

ENV CHROMIUM_PATH=/usr/bin/chromium-browser

COPY --from=builder /app/node_modules ./node_modules
COPY src ./src
COPY views ./views
COPY public ./public
COPY db ./db
COPY package*.json ./

EXPOSE 3000
USER node
CMD ["node", "--max-old-space-size=800", "src/index.js"]
