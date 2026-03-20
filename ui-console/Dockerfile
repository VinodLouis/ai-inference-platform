FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY ui-console/package.json ./package.json
RUN npm install

COPY ui-console/ ./
RUN npm run build

FROM nginx:1.27-alpine

COPY ui-console/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
