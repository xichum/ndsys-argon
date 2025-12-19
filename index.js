const express = require("express");
const app = express();
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const { execSync } = require('child_process');

/**
 * ======================================================================================
 *  ENVIRONMENT CONFIGURATION (环境变量配置)
 *  [注意] 请根据实际情况修改以下变量，或者在部署平台的环境变量设置中填写。
 * ======================================================================================
 */

// [基础运行配置]
// 运行目录，用于存放下载的二进制文件和临时配置 (默认: ./tmp)
const FILE_PATH = process.env.FILE_PATH || './tmp';
// HTTP 服务端口，用于提供订阅访问和保活检测 (默认: 3000)
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
// 用户 UUID (身份 ID)
const UUID = process.env.UUID || '3f07f38f-27b4-4366-a10e-05c97a013e5e';

// [Komari 探针配置] (核心功能)
// Komari 服务端地址 (例如: https://status.yourdomain.com)，不填则不启动探针
const KOMARI_HOST = process.env.KOMARI_HOST || '';
// Komari 通讯 Token (服务端设置的通讯密钥)
const KOMARI_TOKEN = process.env.KOMARI_TOKEN || '';

// [Cloudflare Argo 隧道配置]
// 隧道自定义域名 (例如: argo.yourdomain.com)，不填则使用 TryCloudflare 随机域名
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
// 隧道 Token (推荐) 或 JSON 格式密钥。不填则自动启动临时隧道
const ARGO_AUTH = process.env.ARGO_AUTH || '';
// 隧道内部转发端口 (默认: 8002)
const ARGO_PORT = process.env.ARGO_PORT || 8002;

// [节点参数配置]
// 优选 IP 或优选域名 (用于生成订阅链接中的 address)
const CFIP = process.env.CFIP || 'saas.sin.fan';
// 优选 IP 对应的端口 (通常为 443 或 80)
const CFPORT = process.env.CFPORT || 443;
// 节点名称前缀 (例如: US-Serv00)，最终名称会自动追加 ISP 信息
const NAME = process.env.NAME || '';

// [自动上传与保活配置] (可选)
// 订阅或节点上传接口地址 (例如: https://sub.example.com)
const UPLOAD_URL = process.env.UPLOAD_URL || '';
// 当前项目部署后的外部访问 URL (用于生成远程订阅链接)
const PROJECT_URL = process.env.PROJECT_URL || '';
// 订阅文件下载路径 (例如: sub -> http://url/sub)
const SUB_PATH = process.env.SUB_PATH || 'subb';
// 是否自动向 Serv00 监控添加保活任务 (true/false)
const AUTO_ACCESS = process.env.AUTO_ACCESS || false;

/* ====================================================================================== */

function stealthLog(tag, info) {
    console.log(`\x1b[90m[${tag}] ${info}\x1b[0m`);
}

if (!fs.existsSync(FILE_PATH)) {
    fs.mkdirSync(FILE_PATH);
}

function generateRandomName() {
    const characters = 'abcdefghijklmnopqrstuvwxyz';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

const komariName = 'k' + generateRandomName();
const webName = generateRandomName();
const botName = generateRandomName();

let komariPath = path.join(FILE_PATH, komariName);
let webPath = path.join(FILE_PATH, webName);
let botPath = path.join(FILE_PATH, botName);
let subPath = path.join(FILE_PATH, 'sub.txt');
let bootLogPath = path.join(FILE_PATH, 'boot.log');
let configPath = path.join(FILE_PATH, 'config.json');

function deleteOldNodes() {
    try {
        if (!UPLOAD_URL) return;
        if (!fs.existsSync(subPath)) return;
        let fileContent;
        try { fileContent = fs.readFileSync(subPath, 'utf-8'); } catch { return null; }
        const decoded = Buffer.from(fileContent, 'base64').toString('utf-8');
        const nodes = decoded.split('\n').filter(line => /(vless|vmess|trojan|hysteria2|tuic):\/\//.test(line));
        if (nodes.length === 0) return;
        axios.post(`${UPLOAD_URL}/api/delete-nodes`, JSON.stringify({ nodes }), { headers: { 'Content-Type': 'application/json' } }).catch((error) => { return null; });
    } catch (err) { return null; }
}

function cleanupDirectory() {
    try {
        const files = fs.readdirSync(FILE_PATH);
        files.forEach(file => {
            const filePath = path.join(FILE_PATH, file);
            try {
                const stat = fs.statSync(filePath);
                if (stat.isFile()) fs.unlinkSync(filePath);
            } catch (err) {}
        });
    } catch (err) {}
}

app.get("/", function (req, res) {
    res.type('text/plain').send('System Daemon Active.');
});

async function generateConfig() {
    const config = {
        log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' },
        inbounds: [
            { port: ARGO_PORT, protocol: 'vless', settings: { clients: [{ id: UUID, flow: 'xtls-rprx-vision' }], decryption: 'none', fallbacks: [{ dest: 3001 }, { path: "/vless-argo", dest: 3002 }, { path: "/vmess-argo", dest: 3003 }, { path: "/trojan-argo", dest: 3004 }] }, streamSettings: { network: 'tcp' } },
            { port: 3001, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID }], decryption: "none" }, streamSettings: { network: "tcp", security: "none" } },
            { port: 3002, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID, level: 0 }], decryption: "none" }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vless-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
            { port: 3003, listen: "127.0.0.1", protocol: "vmess", settings: { clients: [{ id: UUID, alterId: 0 }] }, streamSettings: { network: "ws", wsSettings: { path: "/vmess-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
            { port: 3004, listen: "127.0.0.1", protocol: "trojan", settings: { clients: [{ password: UUID }] }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/trojan-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
        ],
        outbounds: [{ protocol: "freedom", tag: "direct" }, { protocol: "blackhole", tag: "block" }]
    };
    fs.writeFileSync(path.join(FILE_PATH, 'config.json'), JSON.stringify(config, null, 2));
}

function getSystemArchitecture() {
    const arch = os.arch();
    return (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') ? 'arm' : 'amd';
}

function downloadFile(fileName, fileUrl) {
    return new Promise((resolve, reject) => {
        const filePath = fileName;
        if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });
        const writer = fs.createWriteStream(filePath);
        axios({ method: 'get', url: fileUrl, responseType: 'stream' })
            .then(response => {
                response.data.pipe(writer);
                writer.on('finish', () => { writer.close(); resolve(filePath); });
                writer.on('error', err => { fs.unlink(filePath, () => { }); reject(err); });
            })
            .catch(err => { reject(err); });
    });
}

async function initializeCore() {
    const architecture = getSystemArchitecture();
    const isArm = architecture === 'arm';
    const komariArch = isArm ? 'arm64' : 'amd64';

    const filesToDownload = [
        { fileName: webPath, fileUrl: `https://${isArm ? 'arm64' : 'amd64'}.ssss.nyc.mn/web` },
        { fileName: botPath, fileUrl: `https://${isArm ? 'arm64' : 'amd64'}.ssss.nyc.mn/bot` }
    ];

    if (KOMARI_HOST && KOMARI_TOKEN) {
        filesToDownload.unshift({
            fileName: komariPath,
            fileUrl: `https://github.com/komari-monitor/komari-agent/releases/latest/download/komari-agent-linux-${komariArch}`
        });
    }

    try {
        const promises = filesToDownload.map(file => downloadFile(file.fileName, file.fileUrl));
        await Promise.all(promises);
    } catch (err) { return; }

    [komariPath, webPath, botPath].forEach(filePath => {
        if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o775);
    });

    if (KOMARI_HOST && KOMARI_TOKEN) {
        let host = KOMARI_HOST.startsWith('http') ? KOMARI_HOST : 'https://' + KOMARI_HOST;
        const command = `nohup ${komariPath} -e ${host} -t ${KOMARI_TOKEN} >/dev/null 2>&1 &`;
        try {
            await exec(command);
            stealthLog('SYS_PROC', `WORKER_SPAWNED [${komariName}] PID:${process.pid + 1}`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {}
    }

    const xrayCommand = `nohup ${webPath} -c ${FILE_PATH}/config.json >/dev/null 2>&1 &`;
    try {
        await exec(xrayCommand);
        await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {}

    if (fs.existsSync(botPath)) {
        let args;
        if (ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
            args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${ARGO_AUTH}`;
        } else if (ARGO_AUTH.includes('TunnelSecret')) {
            fs.writeFileSync(path.join(FILE_PATH, 'tunnel.json'), ARGO_AUTH);
            const tunnelYaml = `tunnel: ${ARGO_AUTH.split('"')[11]}\ncredentials-file: ${path.join(FILE_PATH, 'tunnel.json')}\nprotocol: http2\ningress:\n  - hostname: ${ARGO_DOMAIN}\n    service: http://localhost:${ARGO_PORT}\n    originRequest:\n      noTLSVerify: true\n  - service: http_status:404`;
            fs.writeFileSync(path.join(FILE_PATH, 'tunnel.yml'), tunnelYaml);
            args = `tunnel --edge-ip-version auto --config ${FILE_PATH}/tunnel.yml run`;
        } else {
            args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile ${FILE_PATH}/boot.log --loglevel info --url http://localhost:${ARGO_PORT}`;
        }

        try {
            await exec(`nohup ${botPath} ${args} >/dev/null 2>&1 &`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error) {}
    }
}

async function extractArgoDomain() {
    if (ARGO_DOMAIN && ARGO_AUTH) {
        await generateSubscription(ARGO_DOMAIN);
        return;
    }

    let foundDomain = null;
    const maxRetries = 15;

    for (let i = 0; i < maxRetries; i++) {
        try {
            if (fs.existsSync(bootLogPath)) {
                const fileContent = fs.readFileSync(bootLogPath, 'utf-8');
                const domainMatch = fileContent.match(/https?:\/\/([^ ]*trycloudflare\.com)\/?/);
                if (domainMatch) {
                    foundDomain = domainMatch[1];
                    break; 
                }
            }
        } catch (err) {}
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (foundDomain) {
        await generateSubscription(foundDomain);
    }
}

async function getIspInfo() {
    try {
        const response1 = await axios.get('https://ipapi.co/json/', { timeout: 2000 });
        if (response1.data && response1.data.country_code && response1.data.org) {
            return `${response1.data.country_code}_${response1.data.org}`;
        }
    } catch (error) { return 'Unknown'; }
    return 'Unknown';
}

async function generateSubscription(domain) {
    const ISP = await getIspInfo();
    const nodeName = NAME ? `${NAME}-${ISP}` : ISP;
    
    const VMESS = { v: '2', ps: `${nodeName}`, add: CFIP, port: CFPORT, id: UUID, aid: '0', scy: 'none', net: 'ws', type: 'none', host: domain, path: '/vmess-argo?ed=2560', tls: 'tls', sni: domain, alpn: '', fp: 'firefox' };
    const subTxt = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${domain}&fp=firefox&type=ws&host=${domain}&path=%2Fvless-argo%3Fed%3D2560#${nodeName}\nvmess://${Buffer.from(JSON.stringify(VMESS)).toString('base64')}\ntrojan://${UUID}@${CFIP}:${CFPORT}?security=tls&sni=${domain}&fp=firefox&type=ws&host=${domain}&path=%2Ftrojan-argo%3Fed%3D2560#${nodeName}`;
    
    const base64Content = Buffer.from(subTxt).toString('base64');
    
    stealthLog('NET_IO', `UPSTREAM_BIND: ${domain}`);
    stealthLog('MEM_DUMP', `HEAP_SNAPSHOT_V2 (b64):\n${base64Content}`);
    
    try { fs.writeFileSync(subPath, base64Content); } catch (e) {}
    
    if (UPLOAD_URL && PROJECT_URL) {
        const subscriptionUrl = `${PROJECT_URL}/${SUB_PATH}`;
        const jsonData = { subscription: [subscriptionUrl] };
        axios.post(`${UPLOAD_URL}/api/add-subscriptions`, jsonData, { headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    } else if (UPLOAD_URL) {
        const nodes = subTxt.split('\n');
        const jsonData = JSON.stringify({ nodes });
        axios.post(`${UPLOAD_URL}/api/add-nodes`, jsonData, { headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    }

    app.get(`/${SUB_PATH}`, (req, res) => {
        res.type('text/plain').send(base64Content);
    });
}

function cleanUpFiles() {
    setTimeout(() => {
        const filesToDelete = [bootLogPath, configPath, webPath, botPath, komariPath];
        if (process.platform === 'win32') {
            exec(`del /f /q ${filesToDelete.join(' ')} > nul 2>&1`, (error) => { console.clear(); });
        } else {
            exec(`rm -rf ${filesToDelete.join(' ')} >/dev/null 2>&1`, (error) => { console.clear(); });
        }
    }, 90000); 
}

async function addAutoVisitTask() {
    if (!AUTO_ACCESS || !PROJECT_URL) return;
    try {
        await axios.post('https://oooo.serv00.net/add-url', { url: PROJECT_URL }, { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {}
}

async function startSystem() {
    try {
        deleteOldNodes();
        cleanupDirectory();
        await generateConfig();
        await initializeCore();
        await extractArgoDomain();
        await addAutoVisitTask();
        cleanUpFiles();
    } catch (error) {}
}

startSystem();

app.listen(PORT, () => {
    stealthLog('INIT', `SOCKET_BIND: ${PORT}`);
});