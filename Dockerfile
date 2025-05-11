FROM node:24-slim

RUN mkdir -p /usr/src/bot
WORKDIR /usr/src/bot
COPY . .

RUN npm install
CMD [ "npm", "run", "prod" ]