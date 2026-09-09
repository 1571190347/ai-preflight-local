FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
COPY app/globals.css ./app/globals.css
COPY components ./components
COPY hooks ./hooks
COPY lib ./lib
COPY public ./public
RUN pnpm build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node server ./server
USER node
ENV BIND_ADDRESS=0.0.0.0 PORT=4173
EXPOSE 4173
CMD ["node", "server/index.mjs"]
