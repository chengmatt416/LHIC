# Stage 1: Build
FROM node:24-bookworm AS builder

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY packages/ packages/
COPY apps/ apps/
COPY tsconfig.json ./

RUN npm ci --ignore-scripts \
    && npm run build

# Stage 2: Production image
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    LHIC_ENV=production \
    LHIC_TRACE_DIRECTORY=/var/lib/lhic/traces

WORKDIR /app

# Copy only production artifacts from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Install Playwright browser
RUN npx playwright install --with-deps chromium \
    && npm prune --omit=dev \
    && npm cache clean --force

# Create non-root user
RUN groupadd --system lhic \
    && useradd --system --gid lhic --create-home lhic \
    && mkdir -p /var/lib/lhic/traces \
    && chown -R lhic:lhic /app /ms-playwright /var/lib/lhic

USER lhic

ENTRYPOINT ["node", "apps/cli/dist/main.js"]
CMD ["preflight"]
