FROM node:18-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
COPY public ./public
RUN chown -R node:node /app
USER node
EXPOSE 8080
ENV NODE_ENV=production
ENV PORT=8080
CMD ["node", "server.js"]
