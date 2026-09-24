# SpendGuard — container image (zero-dependency node:http API + static UI)
# Build:  docker build -t spendguard .
# Run:    docker run -p 8181:8181 -e SPENDGUARD_API_KEY=change-me spendguard

FROM node:22-slim
WORKDIR /app

# Install + build all workspace packages
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
COPY tsconfig.base.json ./
RUN npm ci --no-audit --no-fund && npm run build

# Runtime defaults
ENV SPENDGUARD_PORT=8181
ENV SPENDGUARD_LEDGER=/app/data/audit.sqlite
ENV SPENDGUARD_SERV_MODE=local

EXPOSE 8181
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8181/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/index.js"]