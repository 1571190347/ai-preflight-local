FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
ENV API_BIND=0.0.0.0 API_PORT=8053 DNS_BIND=0.0.0.0 DNS_PORT=5353
EXPOSE 8053/tcp 5353/tcp 5353/udp
CMD ["node", "src/server.mjs"]
