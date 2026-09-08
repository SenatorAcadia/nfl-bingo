# Filename: Dockerfile
# Purpose: Build the production NFL BEANO Node.js container.
# Version: 24.1.0

# Section 1: Runtime image
# Install only locked production dependencies on a supported Node release.
FROM node:24-alpine

# Section 2: Application files
# Run as the non-root node account with no database or persistent volume.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .

# Section 3: Container contract
# Expose the HTTP/WebSocket service and verify its local health endpoint.
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "server.js"]
