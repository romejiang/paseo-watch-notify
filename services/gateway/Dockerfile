# Paseo Watch Notify gateway — minimal image.
# The service has zero runtime dependencies (Node built-ins only), so the runtime stage only
# needs dist/ plus the Node binary.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY package.json ./
# Persisted device registry lives on a volume owned by this user.
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
