# Kairos — Next.js 16 + better-sqlite3. Multi-stage build.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# build tools for better-sqlite3's native addon
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# AUTH_SECRET/KAIROS_ENC_KEY are not needed to build; provide dummies to silence warnings.
ENV AUTH_SECRET=build KAIROS_ENC_KEY=build
RUN npm run build

FROM node:20-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Tokyo
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/public ./public
COPY package.json next.config.ts ./
# Persist the SQLite mirror outside the container: -v kairos-data:/data + KAIROS_DB=/data/kairos.db
EXPOSE 3000
CMD ["npm", "run", "start"]
