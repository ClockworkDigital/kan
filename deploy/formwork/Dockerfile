# Package the checked standalone build. See README.md for the build command.
FROM node:24.22.1-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --chown=node:node apps/web/.next/standalone/ ./
COPY --chown=node:node apps/web/.next/static/ ./apps/web/.next/static/
COPY --chown=node:node apps/web/public/ ./apps/web/public/
COPY --chown=node:node apps/web/bootstrap.cjs ./bootstrap.cjs
USER node
EXPOSE 3000
CMD ["node", "bootstrap.cjs"]
