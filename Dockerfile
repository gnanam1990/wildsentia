FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/sim/package.json packages/sim/
COPY packages/server/package.json packages/server/
COPY packages/runner/package.json packages/runner/
RUN npm install --omit=dev --no-audit --no-fund && npm install -g tsx
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["tsx", "packages/server/src/index.ts"]
