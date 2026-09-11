# School ERP API — production image.
# Runs the Express app with production dependencies only, as the non-root
# "node" user. TLS is expected to terminate at a reverse proxy (nginx in the
# compose stack) — the app listens on plain HTTP inside the container.
#
# build:  docker build -t school-erp-backend ./backend
# run:    docker run -p 5000:5000 -e NODE_ENV=production \
#           -e JWT_SECRET=... -e JWT_REFRESH_SECRET=... school-erp-backend
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install ALL dependencies first — the Prisma CLI (dev dep) is needed to
# generate the query client. Pruned to production-only afterwards.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci && npx prisma generate

# Ship the application source (dotenv finds no .env in the image — all
# configuration is expected as container environment variables)
COPY src ./src

# Drop dev dependencies (nodemon, prisma CLI). The generated query client
# lives in node_modules/.prisma, which npm prune leaves untouched.
RUN npm prune --omit=dev && npm cache clean --force

# Run as the non-root user shipped with the official node image
USER node

EXPOSE 5000

# Shell form so ${PORT} resolves from the container environment
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-5000}/health" >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]