#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

(function checkAndInstallDeps() {
  const deps = ['axios', 'express'];
  const missing = deps.filter(d => {
    try { require.resolve(d); return false; } catch (e) { return true; }
  });
  
  if (missing.length > 0) {
    console.log(`Installing dependencies: ${missing.join(', ')}...`);
    try {
      execSync(`npm install ${missing.join(' ')} --no-save --no-package-lock --loglevel=error`, { 
        stdio: 'inherit', 
        env: { ...process.env, npm_config_loglevel: 'silent' } 
      });
    } catch (e) {
      console.error('Failed to install dependencies. Please ensure npm is installed.');
      process.exit(1);
    }
  }
})();

const axios = require('axios');
const express = require('express');
const app = express();

const CONFIG = {

  USR_ID: (process.env.USR_ID || 'a1bfa009-2243-4ae6-a9a5-8f260099bcb7').trim(), // 唯一标识UUID
  TNL_AUTH: (process.env.TNL_AUTH || "").trim(),                                 // 隧道凭证
  TNL_DOM: (process.env.TNL_DOM || "").trim(),                                   // 隧道域名
  
  SYS_HOST: (process.env.SYS_HOST || "").trim(),                                 // 监控系统服务端地址
  SYS_TOKEN: (process.env.SYS_TOKEN || "").trim(),                               // 监控系统通信密钥
  
  TGT_IP: (process.env.TGT_IP || 'cdns.doon.eu.org').trim(),                     // 优选目标IP或域名
  TGT_PORT: parseInt(process.env.TGT_PORT || 443),                               // 优选目标端口
  LCL_PORT: parseInt(process.env.LCL_PORT || 8003),                              // 本地服务内部端口
  SVR_PORT: process.env.SVR_PORT || process.env.PORT || 3000,                    // Web服务监听端口
  
  N_ID: (process.env.N_ID || "").trim(),                                         // 展示名称,留空自动生成
  TKN_PATH: process.env.TKN_PATH || 'subb',                                      // 订阅访问路径,如 /subb
  WRK_DIR: process.env.WRK_DIR || './tmp'                                        // 工作目录
};

if (!fs.existsSync(CONFIG.WRK_DIR)) fs.mkdirSync(CONFIG.WRK_DIR, { recursive: true });

const genHex = () => crypto.randomBytes(6).toString('hex');
const PATHS = {
  CORE: path.join(CONFIG.WRK_DIR, `sys_${genHex()}`),      // 运行核心
  TNL: path.join(CONFIG.WRK_DIR, `net_${genHex()}`),       // 隧道核心
  AGT: path.join(CONFIG.WRK_DIR, `mon_${genHex()}`),       // 监控探针
  CNF: path.join(CONFIG.WRK_DIR, 'config.json'),           // 配置文件
  LOG: path.join(CONFIG.WRK_DIR, 'sys.log'),               // 运行日志
  DAT: path.join(CONFIG.WRK_DIR, 'data.txt')               // 订阅数据
};

const getArch = () => {
  const a = os.arch();
  return (a === 'arm' || a === 'arm64' || a === 'aarch64') ? 'arm64' : 'amd64';
};

const download = async (filePath, url) => {
  const writer = fs.createWriteStream(filePath);
  try {
    const response = await axios({ method: 'get', url: url, responseType: 'stream' });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        writer.close();
        fs.chmodSync(filePath, 0o755);
        resolve(filePath);
      });
      writer.on('error', reject);
    });
  } catch (err) {
    writer.close();
    try { fs.unlinkSync(filePath); } catch(e){}
    throw err;
  }
};

async function setupComponents() {
  const arch = getArch();

  const urls = {
    core: `https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${arch === 'amd64' ? '64' : 'arm64-v8a'}.zip`,
    tnl: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`,
    agt: CONFIG.SYS_HOST ? `https://github.com/komari-monitor/komari-agent/releases/latest/download/komari-agent-linux-${arch}` : null
  };
  
  const zipPath = path.join(CONFIG.WRK_DIR, 'core.zip');

  try {
    const tasks = [
      download(zipPath, urls.core).then(() => {
        execSync(`unzip -o ${zipPath} -d ${CONFIG.WRK_DIR}`, { stdio: 'ignore' });
        fs.renameSync(path.join(CONFIG.WRK_DIR, 'xray'), PATHS.CORE);
        fs.unlinkSync(zipPath);
      }),
      download(PATHS.TNL, urls.tnl)
    ];
    if (urls.agt) tasks.push(download(PATHS.AGT, urls.agt));
    
    await Promise.all(tasks);
  } catch (e) {
    console.error('Component setup failed:', e.message);
    process.exit(1);
  }
}

function genCoreConfig() {
  const conf = {
    log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' },
    inbounds: [
      {
        port: CONFIG.LCL_PORT, protocol: 'vless',
        settings: {
          clients: [{ id: CONFIG.USR_ID, flow: 'xtls-rprx-vision' }],
          decryption: 'none',
          fallbacks: [
            { dest: 3001 },
            { path: "/vless-argo", dest: 3002 },
            { path: "/vmess-argo", dest: 3003 },
            { path: "/trojan-argo", dest: 3004 }
          ]
        },
        streamSettings: { network: 'tcp' }
      },
      { port: 3001, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: CONFIG.USR_ID }], decryption: "none" }, streamSettings: { network: "tcp", security: "none" } },
      { port: 3002, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: CONFIG.USR_ID, level: 0 }], decryption: "none" }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vless-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
      { port: 3003, listen: "127.0.0.1", protocol: "vmess", settings: { clients: [{ id: CONFIG.USR_ID, alterId: 0 }] }, streamSettings: { network: "ws", wsSettings: { path: "/vmess-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
      { port: 3004, listen: "127.0.0.1", protocol: "trojan", settings: { clients: [{ password: CONFIG.USR_ID }] }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/trojan-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
    ],
    dns: { servers: ["https+local://8.8.8.8/dns-query"] },
    outbounds: [{ protocol: "freedom", tag: "direct" }, { protocol: "blackhole", tag: "block" }]
  };
  fs.writeFileSync(PATHS.CNF, JSON.stringify(conf, null, 2));
}

function startServices() {

  if (fs.existsSync(PATHS.CORE)) {
    spawn(PATHS.CORE, ['-c', PATHS.CNF], { detached: true, stdio: 'ignore' }).unref();
  }

  if (fs.existsSync(PATHS.AGT) && CONFIG.SYS_HOST) {
    const host = CONFIG.SYS_HOST.startsWith('http') ? CONFIG.SYS_HOST : `https://${CONFIG.SYS_HOST}`;
    spawn(PATHS.AGT, ['-e', host, '-t', CONFIG.SYS_TOKEN], { detached: true, stdio: 'ignore' }).unref();
  }

  if (fs.existsSync(PATHS.TNL)) {
    let args;
    if (CONFIG.TNL_AUTH && CONFIG.TNL_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
      args = ['tunnel', '--edge-ip-version', 'auto', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', CONFIG.TNL_AUTH];
    } else {
      args = ['tunnel', '--edge-ip-version', 'auto', '--no-autoupdate', '--protocol', 'http2', '--logfile', PATHS.LOG, '--loglevel', 'info', '--url', `http://localhost:${CONFIG.LCL_PORT}`];
    }
    spawn(PATHS.TNL, args, { detached: true, stdio: 'ignore' }).unref();
  }
}

async function getMeta() {
  try {
    const res = await axios.get('https://ipapi.co/json/', { timeout: 4000 });
    if (res.data.country_code) return `${res.data.country_code}_${res.data.org}`;
  } catch (e) {
    try {
      const res2 = await axios.get('http://ip-api.com/json/', { timeout: 4000 });
      if (res2.data.countryCode) return `${res2.data.countryCode}_${res2.data.org}`;
    } catch (e2) {}
  }
  return 'Unknown';
}

async function updateLinks(domain) {
  if (!domain) return;
  
  const meta = await getMeta();
  const name = CONFIG.N_ID ? `${CONFIG.N_ID}-${meta}` : meta;
  
  const vmess = {
    v: "2", ps: name, add: CONFIG.TGT_IP, port: CONFIG.TGT_PORT, id: CONFIG.USR_ID, aid: "0",
    scy: "none", net: "ws", type: "none", host: domain, path: "/vmess-argo?ed=2560",
    tls: "tls", sni: domain, alpn: "", fp: "firefox"
  };

  const links = [
    `vless://${CONFIG.USR_ID}@${CONFIG.TGT_IP}:${CONFIG.TGT_PORT}?encryption=none&security=tls&sni=${domain}&fp=firefox&type=ws&host=${domain}&path=%2Fvless-argo%3Fed%3D2560#${name}`,
    `vmess://${Buffer.from(JSON.stringify(vmess)).toString('base64')}`,
    `trojan://${CONFIG.USR_ID}@${CONFIG.TGT_IP}:${CONFIG.TGT_PORT}?security=tls&sni=${domain}&fp=firefox&type=ws&host=${domain}&path=%2Ftrojan-argo%3Fed%3D2560#${name}`
  ].join('\n');

  fs.writeFileSync(PATHS.DAT, Buffer.from(links).toString('base64'));
  console.log('Node config updated successfully.');
}

async function domainLoop() {
  if (CONFIG.TNL_DOM && CONFIG.TNL_AUTH) {
    await updateLinks(CONFIG.TNL_DOM);
    return;
  }

  let counter = 0;
  const check = async () => {
    if (counter++ > 30) return;
    try {
      if (fs.existsSync(PATHS.LOG)) {
        const logs = fs.readFileSync(PATHS.LOG, 'utf-8');
        const match = logs.match(/https?:\/\/([^ ]*trycloudflare\.com)/);
        if (match) {
          await updateLinks(match[1]);
          return;
        }
      }
    } catch (e) {}
    setTimeout(check, 2000);
  };
  check();
}

function cleanTrace() {
  setTimeout(() => {
    [PATHS.CNF, PATHS.LOG, PATHS.CORE, PATHS.TNL, PATHS.AGT, path.join(CONFIG.WRK_DIR, 'core.zip')]
      .forEach(f => { if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (e) {} });
  }, 90000);
}

app.get('/', (req, res) => res.send('System Operational'));
app.get(`/${CONFIG.TKN_PATH}`, (req, res) => {
  if (fs.existsSync(PATHS.DAT)) {
    res.send(fs.readFileSync(PATHS.DAT, 'utf-8'));
  } else {
    res.status(503).send('Initializing...');
  }
});

app.listen(CONFIG.SVR_PORT, () => {
  console.log(`Service running on port ${CONFIG.SVR_PORT}`);
  (async () => {
    try {
      await setupComponents();
      genCoreConfig();
      startServices();
      await domainLoop();
      cleanTrace();
    } catch (e) {
      console.error('Runtime error:', e);
    }
  })();
});
