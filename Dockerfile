FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache tzdata
ENV TZ=America/Bogota NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY tsconfig.json demo.ts ./
COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
# Al final para no invalidar la caché de npm ci con cada commit.
# Commit que se despliega: docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) .  → GET /api/health lo informa.
ARG GIT_SHA=desconocido
ENV GIT_SHA=$GIT_SHA
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
