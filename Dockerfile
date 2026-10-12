# fnOS 备选部署方式：容器
#
# 服务端零第三方依赖，运行镜像里只有 node:alpine + 构建好的前端，非常小。

# ---------- 构建阶段 ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8020 \
    LOCAL_ROOT=/data

COPY --from=build /app/dist ./dist
COPY server ./server

EXPOSE 8020

# DWG 解析全部在浏览器端完成，这个进程只负责读文件和发静态资源
CMD ["node", "server/index.mjs"]
