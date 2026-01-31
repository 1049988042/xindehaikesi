# 海克斯麻将 - Sealos 容器化
FROM node:18-alpine

WORKDIR /app

# 依赖先装，利用缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# 使用环境变量 PORT（Sealos 会注入）
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
