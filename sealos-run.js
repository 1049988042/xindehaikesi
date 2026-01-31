// sealos-run.js
const { execSync } = require('child_process');

console.log('--- 🚀 海克斯麻将：正在云端初始化 ---');

try {
    // 1. 装 Git
    console.log('正在安装 Git...');
    execSync('apk add --no-cache git', { stdio: 'inherit' });

    // 2. 拉取代码
    console.log('正在拉取 GitHub 代码...');
    execSync('git clone https://github.com/1049988042/xindehaikesi.git .', { stdio: 'inherit' });

    // 3. 装游戏依赖
    console.log('正在安装 npm 插件...');
    execSync('npm install', { stdio: 'inherit' });

    // 4. 启动服务器
    console.log('✅ 全部就绪，正在启动 server.js...');
    require('./server.js'); 

} catch (err) {
    console.error('❌ 启动失败:', err.message);
}