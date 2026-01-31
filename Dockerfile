# 1. 使用 Node.js 18 版本的镜像
FROM node:18-alpine

# 2. 安装基础工具
RUN apk add --no-cache git

# 3. 设置工作目录
WORKDIR /app

# 4. 把你 GitHub 的代码全部下载进来
RUN git clone https://github.com/1049988042/xindehaikesi.git .

# 5. 安装 JS 依赖包
RUN npm install

# 6. 暴露游戏端口 (3000)
EXPOSE 3000

# 7. 最终启动指令（JS 格式）
CMD ["node", "server.js"]