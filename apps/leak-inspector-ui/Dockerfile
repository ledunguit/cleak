FROM node:22-alpine AS build
WORKDIR /app
COPY apps/leak-inspector-ui/package.json apps/leak-inspector-ui/bun.lock ./apps/leak-inspector-ui/
RUN cd apps/leak-inspector-ui && npm install
# Shared scan-flow contract: the UI deep-imports @mcpvul/common/flow/scan-flow-contract
# (alias -> ../../packages/common/src). It is pure TS with no deps, so copying the
# source is enough for tsc + vite to resolve it inside the build stage.
COPY packages/common/ packages/common/
COPY apps/leak-inspector-ui/ apps/leak-inspector-ui/
RUN cd apps/leak-inspector-ui && npm run build

FROM nginx:alpine
COPY apps/leak-inspector-ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/leak-inspector-ui/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
