# Wavelength admin portal. One image, two entrypoints: the server (default CMD) and the
# collector (Cloud Run Job overrides the command to `node src/collector.js <cost|usage>`).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Install production deps first for layer caching. The lockfile is committed, so npm ci
# gives reproducible installs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public

# Cloud Run injects PORT; the server binds 0.0.0.0:$PORT (default 8080).
EXPOSE 8080
CMD ["node", "src/server.js"]
