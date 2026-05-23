FROM node:22-alpine AS build
WORKDIR /app
COPY apps/leak-inspector-ui/package.json apps/leak-inspector-ui/bun.lock ./apps/leak-inspector-ui/
RUN cd apps/leak-inspector-ui && npm install
COPY apps/leak-inspector-ui/ apps/leak-inspector-ui/
RUN cd apps/leak-inspector-ui && npm run build

FROM nginx:alpine
COPY apps/leak-inspector-ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/leak-inspector-ui/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
