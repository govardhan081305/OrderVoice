# One container: builds the React app and serves it from the Node server.
FROM node:22-bookworm-slim AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=client /app/client/dist /app/client/dist
ENV SQLITE_PATH=/data/ordervoice.db
VOLUME ["/data"]
EXPOSE 4000
CMD ["node", "src/index.js"]
