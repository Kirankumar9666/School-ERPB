# School ERP web app — multi-stage build.
# Stage 1 builds the Vite bundle (VITE_* variables are baked in at build
# time); stage 2 serves it from nginx with an SPA fallback and proxies /api
# to the backend service — same origin, so no CORS is needed.
#
# build:  docker build -t school-erp-frontend ./frontend
# run:    docker run -p 8080:80 school-erp-frontend

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

# Base URL the compiled app calls. The default assumes the API is reachable
# at the same origin under /api (the nginx stage proxies it to the backend
# service). Override with --build-arg for other topologies.
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------- serve ----------
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1