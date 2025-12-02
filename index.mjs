import fs from 'fs';
import path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { exec as _exec } from 'child_process';
import util from 'util';
const exec = util.promisify(_exec);
const __dirname = process.cwd();
 
// --- setup folders ---
const dirs = [
  'sessions','logs/users','logs/groups','logs/status',
  'media/chat','media/users','media/groups','media/status',
  'qr','data'
].map(d => path.join(__dirname,d));
 
for(const d of dirs){ if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); try{fs.chmodSync(d,0o777);}catch{} }
 
// --- config ---
const configPath = path.join(__dirname,'config.json');
function readConfig(){ try { return JSON.parse(fs.readFileSync(configPath)); } catch { return { backupGroup:null, owner:null }; } }
function writeConfig(c){ fs.writeFileSync(configPath, JSON.stringify(c,null,2)); }
let config = readConfig();
 
// --- forwarded DB ---
const FORWARDED_FILE = path.join(__dirname,'data','forwarded.json');
function loadForwarded(){ try { return JSON.parse(fs.readFileSync(FORWARDED_FILE)); } catch(e){ return { forwarded: [] }; } }
function saveForwarded(db){ try { fs.writeFileSync(FORWARDED_FILE, JSON.stringify(db,null,2)); } catch(e){ console.error('saveForwarded fail', e); } }
let forwardedDB = loadForwarded();
 
// --- log helpers ---
function appendLog(type,id,line){
  const safeId = (id||'unknown').toString().replace(/[^0-9a-zA-Z@._-]/g,'_');
  const folder = type==='user'?path.join(__dirname,'logs','users'):(type==='group'?path.join(__dirname,'logs','groups'):path.join(__dirname,'logs','status'));
  const file = path.join(folder,`${safeId}.txt`);
  try{ fs.appendFileSync(file,line+'\n'); } catch(e){ console.error('Append log failed',file,e); }
}
 
function saveMedia(type,id,prefix,ext,buffer){
  const safeId = (id||'unknown').toString().replace(/[^0-9a-zA-Z@._-]/g,'_');
  const folder = type==='user'?path.join(__dirname,'media','users',safeId):
                type==='group'?path.join(__dirname,'media','groups',safeId):
                path.join(__dirname,'media','status',safeId);
  if(!fs.existsSync(folder)) fs.mkdirSync(folder,{recursive:true});
  const name = `${prefix}_${Date.now()}.${ext}`;
  const filepath = path.join(folder,name);
  try{ fs.writeFileSync(filepath,buffer); try{fs.chmodSync(filepath,0o666);}catch{} return filepath; } catch(e){ console.error('Save media failed',filepath,e); return null; }
}
 
// --- safe send ---
async function safeSend(sock,jid,message){ try{ await sock.sendMessage(jid,message); return true; } catch(e){ console.error('safeSend failed',e?.message); return false; } }
 
// --- download media ---
async function downloadWithRetry(sock,message,retries=5){
  const baileys = await import('@whiskeysockets/baileys');
  const { downloadMediaMessage } = baileys;
  for(let i=0;i<retries;i++){
    try{
      const buffer = await downloadMediaMessage(message,'buffer',{}, { reuploadRequest: sock.updateMediaMessage });
      return buffer;
    } catch(e){ await new Promise(r=>setTimeout(r,1000)); }
  }
  return null;
}
 
// --- start bot ---
async function start(){
  try{
    const baileys = await import('@whiskeysockets/baileys');
    const { makeWASocket,useMultiFileAuthState,fetchLatestBaileysVersion,makeCacheableSignalKeyStore,getContentType } = baileys;
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname,'sessions'));
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level:'silent' });
    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal:false,
      auth:{ creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys,logger) },
      generateHighQualityLinkPreview:true,
      markOnlineOnConnect:false,
      syncFullHistory:false
    });
 
    sock.ev.on('creds.update', saveCreds);
 
    sock.ev.on('connection.update', update=>{
      const { qr, connection } = update;
      if(qr){ qrcode.generate(qr,{small:true}); import('qrcode').then(q=>q.toFile(path.join(__dirname,'qr',`qr-${Date.now()}.png`),qr)).catch(()=>{}); }
      if(connection==='open'){
        console.log('✅ Connected to WhatsApp');
        config = readConfig();
        if(!config.owner) config.owner = sock.user?.id; writeConfig(config);
        if(config.backupGroup) sock.sendMessage(config.backupGroup,{text:'✅ Logger bot online'}).catch(()=>{});
      } else if(connection==='close'){
        console.log('❌ Connection closed, reconnecting...');
        setTimeout(()=>start().catch(()=>{}),4000);
      }
    });
 
    sock.ev.on('messages.upsert', async ({messages})=>{
      for(const msg of messages){
        if(!msg?.message) continue;
        const remote = msg.key.remoteJid||'';
        const participant = msg.key.participant||remote;
        const isGroup = remote.endsWith('@g.us');
        const senderId = msg.key.fromMe ? sock.user?.id : (participant||'').toString();
        const pushName = msg.pushName||'';
        const time = new Date().toISOString().replace('T',' ').split('.')[0];
 
        // skip bot itself
        if(senderId===config.owner || senderId===sock.user?.id) continue;
 
        const contentType = getContentType(msg.message);
        let text = '';
 
        // --- parse text ---
        if(contentType==='conversation') text = msg.message.conversation;
        else if(contentType==='extendedTextMessage') text = msg.message.extendedTextMessage.text;
        else if(contentType==='imageMessage' || contentType==='videoMessage' || contentType==='audioMessage' || contentType==='documentMessage' || contentType==='stickerMessage'){
          text = msg.message[contentType]?.caption||'';
        } else if(contentType==='viewOnceMessageV2'){
          text = msg.message.viewOnceMessageV2?.message?.imageMessage?.caption || '';
        } else if(contentType==='reactionMessage'){
          text = `Reaction: ${msg.message.reactionMessage?.text}`;
        } else if(contentType==='locationMessage'){
          text = `Location: ${JSON.stringify(msg.message.locationMessage)}`;
        } else if(contentType==='contactMessage'){
          text = `Contact: ${JSON.stringify(msg.message.contactMessage)}`;
        } else if(contentType==='pollCreationMessage'){
          text = `Poll: ${JSON.stringify(msg.message.pollCreationMessage)}`;
        }
 
        // --- parse quoted/forwarded ---
        let quoted = '';
        if(msg.message.extendedTextMessage?.contextInfo?.quotedMessage){
          const qm = msg.message.extendedTextMessage.contextInfo.quotedMessage;
          const qtype = Object.keys(qm)[0];
          quoted = ` [Quoted ${qtype}: ${qm[qtype]?.text||qm[qtype]?.caption||JSON.stringify(qm[qtype])}]`;
        }
 
        const line = `[${time}] ${pushName} (${participant}): ${text}${quoted}`;
 
        // --- save chat log ---
        const safeId = (participant||'unknown').replace(/[^0-9a-zA-Z@._-]/g,'_');
        const chatFile = path.join(__dirname,'media','chat',`${safeId}.txt`);
        fs.appendFileSync(chatFile,line+'\n');
 
        // --- forward to backup group ---
        if(config.backupGroup && !forwardedDB.forwarded.includes(msg.key.id)){
          if(text.length>0) await safeSend(sock,config.backupGroup,{text:line});
 
          // --- handle media ---
          if(['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage','viewOnceMessageV2'].includes(contentType)){
            const buffer = await downloadWithRetry(sock,msg);
            if(buffer){
              const mime = msg.message[contentType]?.mimetype||'application/octet-stream';
              const ext = (mime.split('/')[1]||'bin').split('+')[0];
              const typeKey = isGroup?'group':'user';
              const ownerId = isGroup?remote.split('@')[0]:(participant||'unknown').split('@')[0];
              const saved = saveMedia(typeKey,ownerId,contentType.replace('Message',''),ext,buffer);
              await safeSend(sock,config.backupGroup,{document:buffer,fileName:path.basename(saved),mimetype:mime});
            }
          }
 
          forwardedDB.forwarded.push(msg.key.id);
          saveForwarded(forwardedDB);
        }
 
        console.log('💬',line);
      }
    });
 
    console.log('✅ Universal Logger bot started - waiting for QR / messages');
  } catch(e){ console.error('Start failed',e); setTimeout(()=>start().catch(()=>{}),5000); }
}
 
start();
      
