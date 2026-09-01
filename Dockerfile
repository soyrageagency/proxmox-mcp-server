# Two-stage build: compile the TypeScript with the full toolchain, then ship
# only the runtime deps and the emitted JS on a slim base.
#
#   docker run --rm -i \
#     -e PROXMOX_HOST=https://192.168.1.10:8006 \
#     -e PROXMOX_TOKEN_ID='root@pam!mcp' \
#     -e PROXMOX_TOKEN_SECRET=... \
#     ghcr.io/soyrageagency/proxmox-mcp
#
# The server speaks MCP over stdio, so keep -i (interactive) and do not
# allocate a TTY: stdout is the JSON-RPC stream.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY README.md LICENSE ./

# Drop privileges — the server only makes outbound HTTPS calls to the Proxmox API.
USER node

ENTRYPOINT ["node", "dist/index.js"]
