FROM node:22-alpine
RUN apk add --no-cache tini curl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN chown -R node:node /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 COOKIE_SECURE=1
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","--no-warnings","server/index.js"]
