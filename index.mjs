import fs from 'fs';
import path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { exec as _exec } from 'child_process';
import util from 'util';
const exec = util.promisify(_exec);
const __dirname = process.cwd();

// ensure folders
const dirs = [
  'sessions',
  'logs/users',
  'logs/groups',
  'logs/status',
  'media/users',
  'media/groups',
  'media/status',
  'qr',
  'data'
].map(d => path.join(__dirname, d));
for (const d of dirs) {
  try {
    if (fs.existsSync(d)) {
      if (!fs.statSync(d).isDirectory()) {
        fs.unlinkSync(d);
        fs.mkdirSync(d, { recursive: true });
      }
    } else fs.mkdirSync(d, { recursive: true });
    try { fs.chmodSync(d, 0o777); } catch(e){}
  } catch(e){
    console.error('Failed create dir', d, e);
  }
}

const configPath = path.join(__dirname, 'config.json');
function readConfig(){ try { return JSON.parse(fs.readFileSync(configPath)); } catch { return { backupGroup: null, owner: null, logSendThreshold: 10 }; } }
function writeConfig(c){ fs.writeFileSync(configPath, JSON.stringify(c, null, 2)); }
let config = readConfig();

// forwarded DB
const FORWARDED_FILE = path.join(__dirname, 'data', 'forwarded.json');
function loadForwarded(){ try { return JSON.parse(fs.readFileSync(FORWARDED_FILE)); } catch(e){ return { forwarded: [] }; } }
function saveForwarded(db){ try { fs.writeFileSync(FORWARDED_FILE, JSON.stringify(db, null, 2)); } catch(e){ console.error('saveForwarded fail', e); } }

let forwardedDB = loadForwarded();

const logCounters = {};

function appendLog(type, id, line){
  const safeId = (id||'unknown').toString().replace(/[^0-9a-zA-Z@._-]/g, '_');
  const folder = type === 'user' ? path.join(__dirname,'logs','users') : (type==='group' ? path.join(__dirname,'logs','groups') : path.join(__dirname,'logs','status'));
  const file = path.join(folder, `${safeId}.txt`);
  try { fs.appendFileSync(file, line + '\n'); } catch(e){ console.error('Append log failed', file, e); }
}

function saveMedia(type, id, prefix, ext, buffer){
  const safeId = (id||'unknown').toString().replace(/[^0-9a-zA-Z@._-]/g, '_');
  const folder = type === 'user' ? path.join(__dirname,'media','users', safeId) : (type==='group'? path.join(__dirname,'media','groups', safeId) : path.join(__dirname,'media','status', safeId));
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  const name = `${prefix}_${Date.now()}.${ext}`;
  const filepath = path.join(folder, name);
  try { fs.writeFileSync(filepath, buffer); try { fs.chmodSync(filepath, 0o666); } catch(e){}; return filepath; } catch(e){ console.error('Save media failed', filepath, e); return null; }
}

// helper: get bot id (after connection)
let BOT_ID = null;

// helper: safe send with catch
async function safeSend(sock, jid, message){
  try { await sock.sendMessage(jid, message); return true; } catch(e) { console.error('safeSend failed', e && e.message); return false; }
}

// ----- system probes for !ping -----
async function probeGPU() {
  // Try common probes; return first useful result
  try {
    const { stdout } = await exec('nvidia-smi --query-gpu=name,utilization.gpu,memory.total,memory.used --format=csv,noheader', { timeout: 2000 });
    if (stdout && stdout.trim()) return stdout.trim();
  } catch(e){}
  try {
    const { stdout } = await exec('glxinfo | grep "OpenGL renderer" -m1', { timeout: 2000 });
    if (stdout && stdout.trim()) return stdout.trim();
  } catch(e){}
  // Termux / Android - try adreno info
  try {
    const adrenoPath = '/sys/class/kgsl/kgsl-3d0/gmem_total';
    if (fs.existsSync(adrenoPath)) {
      const mem = fs.readFileSync(adrenoPath, 'utf8').trim();
      return `Adreno gmem_total: ${mem}`;
    }
  } catch(e){}
  return 'N/A';
}

async function collectPing() {
  const os = await import('os');
  const nodeVersion = process.version;
  const uptimeSec = Math.round(process.uptime());
  const osUptime = Math.round(os.uptime());
  const load = os.loadavg ? os.loadavg() : [0,0,0];
  const memTotalMB = Math.round(os.totalmem() / 1024 / 1024);
  const memFreeMB = Math.round(os.freemem() / 1024 / 1024);
  const memUsedMB = memTotalMB - memFreeMB;
  const cpuCount = os.cpus ? os.cpus().length : 'N/A';
  const cpudesc = os.cpus && os.cpus()[0] ? os.cpus()[0].model : 'N/A';
  // disk
  let diskInfo = 'N/A';
  try {
    const { stdout } = await exec('df -h . | sed -n 2p', { timeout: 2000 });
    diskInfo = stdout.trim();
  } catch(e){}
  // top short
  let topShort = '';
  try { const { stdout } = await exec('top -b -n 1 | head -n 6', { timeout: 2000 }); topShort = stdout.split('\\n').slice(0,6).join('\\n'); } catch(e){}
  const gpu = await probeGPU();
  return {
    nodeVersion, uptimeSec, osUptime, load, memTotalMB, memFreeMB, memUsedMB, cpuCount, cpudesc, diskInfo, topShort, gpu
  };
}

// ----- start baileys -----
async function start() {
  try {
    const baileys = await import('@whiskeysockets/baileys');
    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, getContentType, downloadMediaMessage } = baileys;
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname,'sessions'));
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });
    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { qr, connection } = update;
      if (qr) {
        try {
          qrcode.generate(qr, { small: true });
          const qrPath = path.join(__dirname,'qr', `qr-${Date.now()}.png`);
          import('qrcode').then(qrmod => qrmod.toFile(qrPath, qr)).catch(()=>{});
          console.log('📸 QR saved to', qrPath);
        } catch(e){ console.log('QR generate failed', e); }
      }
      if (connection === 'open') {
        console.log('✅ Connected to WhatsApp');
        config = readConfig();
        // try to set BOT_ID from sock info
        try { BOT_ID = sock.user && sock.user.id ? sock.user.id : (state && state.creds && state.creds.registeredId ? state.creds.registeredId + '@s.whatsapp.net' : null); } catch(e){}
        // default owner to bot id if not set
        if (BOT_ID && (!config.owner)) { config.owner = BOT_ID; writeConfig(config); }
        if (config.backupGroup) { sock.sendMessage(config.backupGroup, { text: '✅ Logger bot is online' }).catch(()=>{}); }
      } else if (connection === 'close') {
        console.log('❌ Connection closed, reconnecting...');
        setTimeout(()=>start().catch(()=>{}), 4000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg?.message) continue;
          const contentType = getContentType(msg.message);
          const remote = msg.key.remoteJid || '';
          const isGroup = remote.endsWith('@g.us');
          const participant = msg.key.participant || remote;
          const pushName = msg.pushName || '';
          const time = new Date().toISOString().replace('T',' ').split('.')[0];
          const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
          const prefix = '!';
          // COMMANDS -- handle before other processing
          if (typeof text === 'string' && text.trim().startsWith(prefix)) {
            const cmdText = text.trim();
            const parts = cmdText.slice(prefix.length).trim().split(/\s+/);
            const name = (parts.shift()||'').toLowerCase();
            const args = parts;
            // !setgroupbackup (original behavior preserved)
            if (name === 'setgroupbackup') {
              if (isGroup) {
                config.backupGroup = remote;
                writeConfig(config);
                await sock.sendMessage(remote, { text: '✅ This group has been set as backup group.' });
                console.log('Backup group set to', remote);
              } else {
                await sock.sendMessage(remote, { text: '⚠️ Use this command inside the group you want to set as backup.' });
              }
              continue;
            }
            // new: !setowner -> set owner to bot id
            if (name === 'setowner') {
              // ensure BOT_ID known
              if (!BOT_ID) {
                // try to set from sock or state
                BOT_ID = sock.user && sock.user.id ? sock.user.id : (state && state.creds && state.creds.registeredId ? state.creds.registeredId + '@s.whatsapp.net' : null);
              }
              if (!BOT_ID) {
                await sock.sendMessage(remote, { text: '❌ Unable to determine bot id. Make sure bot is connected.' });
                continue;
              }
              config.owner = BOT_ID;
              writeConfig(config);
              await sock.sendMessage(remote, { text: `✅ Owner set to bot id: ${BOT_ID}` });
              continue;
            }
            // new: !menu (format B)
            if (name === 'menu') {
              const status = (config.backupGroup ? 'ON' : 'OFF');
              const features = [
                '📘 WA Logger Ultimate',
                '=========================',
                '📌 Commands',
                '• !menu — show commands',
                '• !ping — system stats',
                '• !setowner — set bot as owner (prevents double-forward)',
                '• !setgroupbackup — set backup group',
                '',
                '⚙ Features',
                `• Auto-Backup Chat & Media (backup group: ${config.backupGroup||'not set'})`,
                '• Anti Double Forward (prevents duplicate forwards)',
                '• Auto Log Upload',
                '• Status Saver'
              ].join('\\n');
              await sock.sendMessage(remote, { text: features });
              continue;
            }
            // new: !ping -> detailed system stats
            if (name === 'ping') {
              const started = Date.now();
              const stats = await collectPing();
              const elapsed = Date.now() - started;
              const parts = [
                '╔══⟦ BOT PING ⟧══╗',
                `• Response: ${elapsed} ms`,
                `• Node: ${stats.nodeVersion}`,
                `• CPU: ${stats.cpudesc}`,
                `• CPU cores: ${stats.cpuCount}`,
                `• Load (1,5,15): ${Array.isArray(stats.load)?stats.load.map(n=>n.toFixed(2)).join(', '):stats.load}`,
                `• Memory total: ${stats.memTotalMB} MB`,
                `• Memory used: ${stats.memUsedMB} MB`,
                `• Memory free: ${stats.memFreeMB} MB`,
                `• OS uptime (s): ${stats.osUptime}`,
                `• Process uptime (s): ${stats.uptimeSec}`,
                `• Disk (df -h .):`,
                '```' + stats.diskInfo + '```',
                `• GPU probe: ${stats.gpu}`
              ];
              if (stats.topShort) { parts.push('• top (short):'); parts.push('```'+stats.topShort+'```'); }
              parts.push('╚════════════════╝');
              await sock.sendMessage(remote, { text: parts.join('\\n') });
              continue;
            }
            // unknown command -> ignore
            continue;
          } // end commands

          // log text messages
          if (text && text.length>0){
            const line = `[${time}] ${pushName} (${participant}): ${text}`;
            if (isGroup) {
              appendLog('group', remote, line);
              logCounters[remote] = (logCounters[remote]||0)+1;
            } else {
              appendLog('user', participant, line);
              logCounters[participant] = (logCounters[participant]||0)+1;
            }
            console.log('💬', line);
          }

          const isStatus = (remote === 'status@broadcast' || (remote && remote.includes('status')));
          // handle status media
          if (isStatus && ['imageMessage','videoMessage'].includes(contentType)) {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
              const mime = msg.message[contentType]?.mimetype || 'application/octet-stream';
              const ext = (mime.split('/')[1]||'bin').split('+')[0];
              const filePath = saveMedia('status', (participant||'unknown').split('@')[0], 'status', ext, buffer);
              const line = `[${time}] STATUS from ${participant}: saved ${filePath}`;
              appendLog('status', (participant||'unknown').split('@')[0], line);
              console.log('🖼️', line);
              // forward with anti-double-forward
              if (config.backupGroup) {
                const mid = msg.key && msg.key.id ? msg.key.id : null;
                if (mid && (!forwardedDB.forwarded.includes(mid)) && (participant !== (config.owner||BOT_ID))) {
                  await safeSend(sock, config.backupGroup, { document: buffer, fileName: path.basename(filePath), mimetype: mime });
                  forwardedDB.forwarded.push(mid);
                  saveForwarded(forwardedDB);
                  console.log('📤 Status forwarded to backup group');
                } else {
                  console.log('⏭️ Status skipped (already forwarded or from owner)');
                }
              }
            } catch(e){ console.error('Status save failed', e); }
            continue;
          }

          // handle regular media
          if (['imageMessage','videoMessage','audioMessage','documentMessage','viewOnceMessageV2'].includes(contentType)){
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
              const mime = msg.message[contentType]?.mimetype || 'application/octet-stream';
              const ext = (mime.split('/')[1]||'bin').split('+')[0];
              const ownerId = isGroup ? remote.split('@')[0] : (participant||'unknown').split('@')[0];
              const typeKey = isGroup ? 'group' : 'user';
              const saved = saveMedia(typeKey, ownerId, contentType.replace('Message',''), ext, buffer);
              const line = `[${time}] MEDIA ${contentType} from ${participant} saved ${saved}`;
              appendLog(typeKey === 'group' ? 'group' : 'user', typeKey === 'group' ? remote : (participant||'unknown').split('@')[0], line);
              console.log('📁', line);
              if (config.backupGroup) {
                const mid = msg.key && msg.key.id ? msg.key.id : null;
                if (mid && (!forwardedDB.forwarded.includes(mid)) && (participant !== (config.owner||BOT_ID))) {
                  await safeSend(sock, config.backupGroup, { document: buffer, fileName: path.basename(saved), mimetype: mime });
                  forwardedDB.forwarded.push(mid);
                  saveForwarded(forwardedDB);
                  console.log('📤 Media forwarded to backup group');
                } else {
                  console.log('⏭️ Media skipped (already forwarded or from owner)');
                }
              }
              const counterKey = isGroup ? remote : participant;
              logCounters[counterKey] = (logCounters[counterKey]||0)+1;
            } catch(e){ console.error('Media save failed', e); }
          }

          // threshold-based log send (unchanged)
          const threshold = (config.logSendThreshold && Number(config.logSendThreshold))||10;
          for (const [key, count] of Object.entries(logCounters)){
            if (count >= threshold){
              try {
                const isG = key.endsWith('@g.us');
                const safeKey = key.replace(/[^0-9a-zA-Z@._-]/g,'_');
                const fileToSend = isG ? path.join(__dirname,'logs','groups', `${safeKey}.txt`) : path.join(__dirname,'logs','users', `${safeKey.split('@')[0]}.txt`);
                if (fs.existsSync(fileToSend) && config.backupGroup){
                  // check forwarded DB for fileToSend marker: use hash of filename + mtime to avoid double-send (simple)
                  const stat = fs.statSync(fileToSend);
                  const marker = `${path.basename(fileToSend)}:${stat.mtimeMs}`;
                  if (!forwardedDB.forwarded.includes(marker) && (BOT_ID !== (config.owner||BOT_ID))) {
                    await safeSend(sock, config.backupGroup, { document: fs.readFileSync(fileToSend), fileName: path.basename(fileToSend), mimetype: 'text/plain' });
                    forwardedDB.forwarded.push(marker);
                    saveForwarded(forwardedDB);
                    console.log('📤 Sent log', fileToSend, 'to backup group');
                  } else {
                    console.log('⏭️ Log skipped (already sent or owner)');
                  }
                }
              } catch(e){ console.error('Failed sending log file', e); }
              logCounters[key] = 0;
            }
          }

        } catch(e){
          console.error('messages.upsert error', e);
        }
      }
    });
    console.log('✅ Logger bot started - waiting for QR / messages');
  } catch(e){
    console.error('Start failed', e);
    setTimeout(()=>start().catch(()=>{}), 5000);
  }
}

start();
