import fs from 'fs';
import path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
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
  'qr'
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

const logCounters = {};

function appendLog(type, id, line){
  const safeId = id.replace(/[^0-9a-zA-Z@._-]/g, '_');
  const folder = type === 'user' ? path.join(__dirname,'logs','users') : (type==='group' ? path.join(__dirname,'logs','groups') : path.join(__dirname,'logs','status'));
  const file = path.join(folder, `${safeId}.txt`);
  try { fs.appendFileSync(file, line + '\n'); } catch(e){ console.error('Append log failed', file, e); }
}

function saveMedia(type, id, prefix, ext, buffer){
  const safeId = id.replace(/[^0-9a-zA-Z@._-]/g, '_');
  const folder = type === 'user' ? path.join(__dirname,'media','users', safeId) : (type==='group'? path.join(__dirname,'media','groups', safeId) : path.join(__dirname,'media','status', safeId));
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  const name = `${prefix}_${Date.now()}.${ext}`;
  const filepath = path.join(folder, name);
  try { fs.writeFileSync(filepath, buffer); try { fs.chmodSync(filepath, 0o666); } catch(e){}; return filepath; } catch(e){ console.error('Save media failed', filepath, e); return null; }
}

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

          if (typeof text === 'string' && text.trim().toLowerCase().startsWith('!setgroupbackup')){
            if (isGroup){
              config.backupGroup = remote;
              writeConfig(config);
              await sock.sendMessage(remote, { text: '✅ This group has been set as backup group.' });
              console.log('Backup group set to', remote);
            } else {
              await sock.sendMessage(remote, { text: '⚠️ Use this command inside the group you want to set as backup.' });
            }
            continue;
          }

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
          if (isStatus && ['imageMessage','videoMessage'].includes(contentType)) {
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
              const mime = msg.message[contentType]?.mimetype || 'application/octet-stream';
              const ext = mime.split('/')[1]||'bin';
              const filePath = saveMedia('status', participant.split('@')[0], 'status', ext, buffer);
              const line = `[${time}] STATUS from ${participant}: saved ${filePath}`;
              appendLog('status', participant.split('@')[0], line);
              console.log('🖼️', line);
              if (config.backupGroup) {
                await sock.sendMessage(config.backupGroup, { document: buffer, fileName: path.basename(filePath), mimetype: mime }).catch(()=>{});
                console.log('📤 Status forwarded to backup group');
              }
            } catch(e){ console.error('Status save failed', e); }
            continue;
          }

          if (['imageMessage','videoMessage','audioMessage','documentMessage','viewOnceMessageV2'].includes(contentType)){
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
              const mime = msg.message[contentType]?.mimetype || 'application/octet-stream';
              const ext = mime.split('/')[1]||'bin';
              const ownerId = isGroup ? remote.split('@')[0] : participant.split('@')[0];
              const typeKey = isGroup ? 'group' : 'user';
              const saved = saveMedia(typeKey, ownerId, contentType.replace('Message',''), ext, buffer);
              const line = `[${time}] MEDIA ${contentType} from ${participant} saved ${saved}`;
              appendLog(isGroup ? 'group' : 'user', isGroup ? remote : participant.split('@')[0], line);
              console.log('📁', line);
              if (config.backupGroup) {
                await sock.sendMessage(config.backupGroup, { document: buffer, fileName: path.basename(saved), mimetype: mime }).catch(()=>{});
                console.log('📤 Media forwarded to backup group');
              }
              const counterKey = isGroup ? remote : participant;
              logCounters[counterKey] = (logCounters[counterKey]||0)+1;
            } catch(e){ console.error('Media save failed', e); }
          }

          const threshold = (config.logSendThreshold && Number(config.logSendThreshold))||10;
          for (const [key, count] of Object.entries(logCounters)){
            if (count >= threshold){
              try {
                const isG = key.endsWith('@g.us');
                const safeKey = key.replace(/[^0-9a-zA-Z@._-]/g,'_');
                const fileToSend = isG ? path.join(__dirname,'logs','groups', `${safeKey}.txt`) : path.join(__dirname,'logs','users', `${safeKey.split('@')[0]}.txt`);
                if (fs.existsSync(fileToSend) && config.backupGroup){
                  await sock.sendMessage(config.backupGroup, { document: fs.readFileSync(fileToSend), fileName: path.basename(fileToSend), mimetype: 'text/plain' }).catch(()=>{});
                  console.log('📤 Sent log', fileToSend, 'to backup group');
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
