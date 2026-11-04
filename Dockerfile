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
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
