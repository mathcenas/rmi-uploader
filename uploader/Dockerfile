FROM node:18-alpine
RUN apk add --no-cache bash docker-cli
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
COPY README.md ./
COPY public ./public
EXPOSE 8080
ENV NODE_ENV=production
ENV PORT=8080
CMD ["node", "server.js"]
