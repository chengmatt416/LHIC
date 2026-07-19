FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    LHIC_ENV=production \
    LHIC_TRACE_DIRECTORY=/var/lib/lhic/traces

WORKDIR /app

COPY . .

RUN npm ci \
    && npm run build \
    && npx playwright install --with-deps chromium \
    && npm prune --omit=dev \
    && npm cache clean --force

RUN groupadd --system lhic \
    && useradd --system --gid lhic --create-home lhic \
    && install -d -m 0700 -o lhic -g lhic /var/lib/lhic/traces \
    && chown -R lhic:lhic /app /ms-playwright /var/lib/lhic

USER lhic

ENTRYPOINT ["node", "apps/cli/dist/main.js"]
CMD ["preflight"]
