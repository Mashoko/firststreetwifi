FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN npm run init-db
EXPOSE 3000
CMD ["npm", "start"]
