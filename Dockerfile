# ---------- Build stage ----------
FROM node:22-alpine AS build
WORKDIR /app

# Установим зависимости
COPY package*.json ./
RUN npm ci

# Сборка TS
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Runtime stage ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Только prod-зависимости
COPY package*.json ./
RUN npm ci --omit=dev

# Собранный код
COPY --from=build /app/dist ./dist

# Не копируем .env — передавайте переменные окружения при запуске
CMD ["node", "dist/index.js"]
