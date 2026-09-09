FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
ENV PING_AGENT_BIND=0.0.0.0 PING_AGENT_PORT=8060
EXPOSE 8060
CMD ["node", "src/server.mjs"]
