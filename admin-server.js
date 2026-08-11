/* ==========================================================================
   MIST ADMIN SERVER
   --------------------------------------------------------------------------
   A single self-contained backend you run and control.

   WHAT IT DOES
     • Holds all your API keys server-side (never in the browser)
     • Proxies every chat to your chosen provider (NVIDIA NIM, OpenAI-compatible,
       Anthropic, or Gemini) and streams it back
     • Records every chat and project as it passes through
     • Lets you ban any user from a private admin console
     • Stores everything in one JSON file you can back up, edit, or delete

   REQUIREMENTS
     • Node.js 18 or newer. No npm install. No dependencies.

   RUN
     ADMIN_PASSWORD=your-secret node admin-server.js
     (defaults to port 8787 and password "mist-admin" if you set nothing)

   THEN
     • Admin console:  http://localhost:8787/admin
     • Website points its endpoint at:  http://your-server:8787/api/chat
   ========================================================================== */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------ config ------------------------------ */
const PORT = process.env.PORT || 8787;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'mist-data.json');
const FIRST_RUN_PASSWORD = process.env.ADMIN_PASSWORD || '0000';
const SESSION_HOURS = 12;
// Daily message cap per user (protects your API bill). 0 = unlimited.
const MAX_MSGS_PER_DAY = Number(process.env.MAX_MSGS_PER_DAY || 100);
// The website file this server also hosts at "/". Put mist.html next to this file.
const SITE_FILE = process.env.SITE_FILE || path.join(__dirname, 'mist.html');

/* OAuth (optional). Fill these via env vars to turn the GitHub/Google buttons
   into real logins. Left blank, the website falls back to a local account. */
const OAUTH = {
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    scope: 'read:user user:email'
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scope: 'openid email profile'
  }
};
// OAuth callbacks are derived from the incoming request (or PUBLIC_URL / SITE_URL env if set).

/* ------------------------------ storage ------------------------------ */
function blankData() {
  return {
    settings: { passHash: null, passSalt: null },
    providers: {
      nim:        { label: 'NVIDIA NIM',       format: 'openai',    baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions', apiKey: '' },
      openai:     { label: 'OpenAI (ChatGPT)', format: 'openai',    baseUrl: 'https://api.openai.com/v1/chat/completions', apiKey: '' },
      anthropic:  { label: 'Anthropic (Claude)',format: 'anthropic', baseUrl: '', apiKey: '' },
      gemini:     { label: 'Google Gemini',    format: 'gemini',    baseUrl: '', apiKey: '' },
      xai:        { label: 'xAI (Grok)',       format: 'openai',    baseUrl: 'https://api.x.ai/v1/chat/completions', apiKey: '' },
      mistral:    { label: 'Mistral',          format: 'openai',    baseUrl: 'https://api.mistral.ai/v1/chat/completions', apiKey: '' },
      deepseek:   { label: 'DeepSeek',         format: 'openai',    baseUrl: 'https://api.deepseek.com/chat/completions', apiKey: '' },
      kimi:       { label: 'Kimi (Moonshot)',  format: 'openai',    baseUrl: 'https://api.moonshot.ai/v1/chat/completions', apiKey: '' },
      perplexity: { label: 'Perplexity',       format: 'openai',    baseUrl: 'https://api.perplexity.ai/chat/completions', apiKey: '' },
      qwen:       { label: 'Qwen (Alibaba)',   format: 'openai',    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey: '' },
      /* Image/video providers for Mist 3 */
      stability:  { label: 'Stability AI (images)', format: 'stability', baseUrl: 'https://api.stability.ai/v2beta/stable-image/generate/core', apiKey: '' },
      replicate:  { label: 'Replicate (images/video)', format: 'replicate', baseUrl: 'https://api.replicate.com/v1/predictions', apiKey: '' }
    },
    routing: {
      mist1: { provider: 'nim', model: 'google/gemma-4-31b-it', fallbacks: [] },
      /* Mist 2 has two chains:
         - codingChain: used for plain text / coding (up to 6 keys)
         - multimodalChain: used when the user sends media or a URL  */
      mist2: {
        codingChain: [
          { provider: 'nim',  model: 'google/gemma-4-31b-it' },
          { provider: 'qwen', model: 'qwen3.8-max' },
          { provider: 'xai',  model: 'grok-4.5' }
        ],
        multimodalChain: [
          { provider: 'gemini', model: 'gemini-2.0-flash' }
        ],
        fallbacks: []
      },
      /* Mist 3 is a chat model that crafts prompts. The actual image generation
         happens via /api/generate route, using stability/replicate. */
      mist3: { provider: 'gemini', model: 'gemini-2.0-flash', fallbacks: [
        { provider: 'nim', model: 'google/gemma-4-31b-it' }
      ] }
    },
    /* Custom system prompts — leave blank to use built-in prompts */
    systemPrompts: { mist1: '', mist2: '', mist3: '', stella: '' },
    /* Which assistant Stella uses (mist1/mist2/mist3). Falls back to mist2. */
    stellaAssistant: 'mist2',
    /* Workspaces — allow multiple users on one account */
    workspaces: {},   // { workspaceId: { name, ownerId, memberIds:[], inviteToken } }
    /* Connect tokens — for the CLI bridge to control a machine */
    connectTokens: {}, // { token: { userId, deviceLabel, createdAt, lastSeen } }
    users: {},
    chats: {},
    projects: {},
    sessions: {}
  };
}

let DB = load();

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Object.assign(blankData(), d);
  } catch {
    const fresh = blankData();
    const salt = crypto.randomBytes(16).toString('hex');
    fresh.settings.passSalt = salt;
    fresh.settings.passHash = hashPass(FIRST_RUN_PASSWORD, salt);
    return fresh;
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 120);
}

/* ------------------------------ helpers ------------------------------ */
function hashPass(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }
function checkPass(pw) {
  if (!DB.settings.passHash) return false;
  const h = hashPass(pw, DB.settings.passSalt);
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(DB.settings.passHash));
}
function setPass(pw) {
  DB.settings.passSalt = crypto.randomBytes(16).toString('hex');
  DB.settings.passHash = hashPass(pw, DB.settings.passSalt);
  save();
}
const uid = () => crypto.randomBytes(9).toString('hex');
const nowMs = () => Date.now();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
async function readJson(req) { try { return JSON.parse(await readBody(req)); } catch { return null; } }

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function newSession() {
  const token = crypto.randomBytes(24).toString('hex');
  DB.sessions[token] = nowMs() + SESSION_HOURS * 3600e3;
  save();
  return token;
}
function validSession(req) {
  const t = cookies(req).mist_admin;
  if (!t) return false;
  const exp = DB.sessions[t];
  if (!exp || exp < nowMs()) { delete DB.sessions[t]; return false; }
  return true;
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, headers || {}));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Mist-User');
}
function mask(k) { return k ? k.slice(0, 4) + '••••' + k.slice(-4) : ''; }

/* ------------------------------ provider adapters ------------------------------ */
/* Each adapter builds an upstream request and knows how to pull the text delta
   out of that provider's streaming format. Everything is re-emitted to the
   browser as OpenAI-style SSE, so the website only ever parses one format. */

function buildUpstream(providerCfg, model, system, messages) {
  const fmt = providerCfg.format;
  const key = providerCfg.apiKey;

  if (fmt === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, stream: true, max_tokens: 2048, system, messages })
      }
    };
  }
  if (fmt === 'gemini') {
    return {
      url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(key),
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
        })
      }
    };
  }
  // default: OpenAI-compatible (NIM, OpenAI, xAI, Qwen, Groq, OpenRouter, Together, DeepSeek…)
  return {
    url: providerCfg.baseUrl || 'https://integrate.api.nvidia.com/v1/chat/completions',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model, stream: true, max_tokens: 2048, temperature: 0.7,
        messages: [{ role: 'system', content: system }, ...messages]
      })
    }
  };
}

function extractDelta(fmt, json) {
  try {
    const j = JSON.parse(json);
    if (fmt === 'anthropic') return j.type === 'content_block_delta' ? (j.delta && j.delta.text) || '' : '';
    if (fmt === 'gemini') return (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text) || '';
    return (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
  } catch { return ''; }
}

/* Detect if any message contains a URL or image marker — routes to multimodal chain */
function isMultimodal(messages) {
  return messages.some(m => {
    if (Array.isArray(m.content)) return true; // vision content array
    const t = (typeof m.content === 'string' ? m.content : '').toLowerCase();
    return /https?:\/\//.test(t) || /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|webm)(\?|$| )/i.test(t);
  });
}

/* Read API key with env var fallback. Env vars survive Render restarts,
   so users can set keys as environment variables and never lose them.
   Format: <PROVIDER_ID>_KEY  (e.g. NIM_KEY, XAI_KEY, GEMINI_KEY) */
function keyFor(providerId) {
  const dbKey = DB.providers[providerId] && DB.providers[providerId].apiKey;
  if (dbKey) return dbKey;
  const envKey = process.env[providerId.toUpperCase() + '_KEY'];
  return envKey || '';
}

/* Resolve an assistant + messages into an ordered list of {providerCfg,model,format} to try.
   Mist 2 uses codingChain or multimodalChain depending on content. Max 6 targets. */
function resolveTargets(assistant, messages) {
  const route = DB.routing[assistant];
  if (!route) return [];

  let chain;
  if (assistant === 'mist2') {
    const useMultimodal = isMultimodal(messages || []);
    chain = useMultimodal
      ? (route.multimodalChain || [])
      : (route.codingChain || [{ provider: route.provider, model: route.model }]);
    // append global fallbacks after chain
    chain = [...chain, ...(route.fallbacks || [])];
  } else {
    chain = [{ provider: route.provider, model: route.model }, ...(route.fallbacks || [])];
  }

  return chain
    .slice(0, 6) // hard cap at 6
    .map(t => {
      const p = DB.providers[t.provider];
      if (!p) return null;
      const key = keyFor(t.provider);
      if (!key) return null;
      // clone provider with the resolved key so buildUpstream uses it
      return { providerCfg: Object.assign({}, p, { apiKey: key }), model: t.model };
    })
    .filter(Boolean);
}

/* ------------------------------ user tracking ------------------------------ */
function touchUser(userId) {
  if (!userId) userId = 'anon';
  let u = DB.users[userId];
  if (!u) { u = DB.users[userId] = { id: userId, firstSeen: nowMs(), lastSeen: nowMs(), messages: 0, banned: false }; }
  u.lastSeen = nowMs();
  return u;
}
function recordChat(userId, meta, userMessages, assistantReply) {
  if (!meta || !meta.chatId) return;
  const c = DB.chats[meta.chatId] || (DB.chats[meta.chatId] = { id: meta.chatId, userId, createdAt: nowMs(), messages: [] });
  c.userId = userId;
  c.title = meta.title || c.title || 'Untitled';
  c.assistant = meta.assistant || c.assistant;
  c.messages = userMessages.concat(assistantReply ? [{ role: 'assistant', content: assistantReply }] : []);
  c.updatedAt = nowMs();
  save();
}

/* ------------------------------ chat proxy ------------------------------ */
async function handleChat(req, res) {
  cors(res);
  const body = await readJson(req);
  if (!body || !Array.isArray(body.messages)) return send(res, 400, { error: 'Bad request' });

  const userId = req.headers['x-mist-user'] || body.userId || 'anon';
  const user = touchUser(userId);
  if (user.banned) return send(res, 403, { error: 'Your access has been suspended.' });

  // daily cap — resets each calendar day, protects your API bill
  if (MAX_MSGS_PER_DAY > 0) {
    const today = new Date().toISOString().slice(0, 10);
    if (user.day !== today) { user.day = today; user.dayCount = 0; }
    if (user.dayCount >= MAX_MSGS_PER_DAY) {
      return send(res, 429, { error: "You've reached today's message limit. Try again tomorrow." });
    }
    user.dayCount++;
  }
  user.messages++;

  const assistant = ['mist1','mist2','mist3'].includes(body.assistant) ? body.assistant : 'mist1';
  const messages = body.messages.slice(-24);
  const targets = resolveTargets(assistant, messages);
  if (!targets.length) return send(res, 503, { error: 'No API key configured for ' + assistant + '. Set one in the admin console → Keys & Models.' });

  // use custom system prompt from admin if set, otherwise use what the site sent
  const customPrompt = (DB.systemPrompts || {})[assistant];
  const system = (customPrompt && customPrompt.trim()) ? customPrompt.trim() : (body.system || 'You are a helpful assistant.');
  const meta = { chatId: body.chatId, title: body.title, assistant };

  for (let i = 0; i < targets.length; i++) {
    const { providerCfg, model } = targets[i];
    const { url, init } = buildUpstream(providerCfg, model, system, messages);
    let upstream;
    try {
      upstream = await fetch(url, init);
    } catch (e) {
      if (i === targets.length - 1) return send(res, 502, { error: 'Provider unreachable: ' + e.message });
      continue;
    }
    if (!upstream.ok || !upstream.body) {
      if ((upstream.status === 429 || upstream.status === 503) && i < targets.length - 1) continue;
      const txt = await upstream.text().catch(() => '');
      if (i === targets.length - 1) return send(res, upstream.status, { error: 'Provider error: ' + txt.slice(0, 300) });
      continue;
    }

    // stream + normalize + accumulate for logging
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-model-used': model });
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split('\n\n'); buf = events.pop();
        for (const ev of events) {
          for (const line of ev.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            const piece = extractDelta(providerCfg.format, data);
            if (piece) {
              full += piece;
              res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
            }
          }
        }
      }
    } catch { /* client likely disconnected */ }
    res.write('data: [DONE]\n\n');
    res.end();
    recordChat(userId, meta, messages, full);
    return;
  }
}

/* ------------------------------ sync (projects + chat meta) ------------------------------ */
async function handleSync(req, res) {
  cors(res);
  const body = await readJson(req);
  if (!body) return send(res, 400, { error: 'Bad request' });
  const userId = req.headers['x-mist-user'] || body.userId || 'anon';
  const user = touchUser(userId);
  if (user.banned) return send(res, 403, { error: 'suspended' });

  if (Array.isArray(body.projects)) {
    body.projects.forEach(p => {
      if (!p.id) return;
      DB.projects[p.id] = { id: p.id, userId, name: p.name || 'Project', instructions: p.instructions || '', files: (p.files || '').slice(0, 20000), updatedAt: nowMs() };
    });
  }
  save();
  return send(res, 200, { ok: true });
}

/* ------------------------------ admin API ------------------------------ */
async function handleAdminApi(req, res, urlPath) {
  // login is the only unauthenticated admin route
  if (urlPath === '/admin/login' && req.method === 'POST') {
    const b = await readJson(req);
    if (b && checkPass(b.password || '')) {
      const token = newSession();
      res.setHeader('Set-Cookie', `mist_admin=${token}; HttpOnly; Path=/; Max-Age=${SESSION_HOURS * 3600}; SameSite=Lax`);
      return send(res, 200, { ok: true });
    }
    return send(res, 401, { error: 'Wrong password' });
  }

  if (!validSession(req)) return send(res, 401, { error: 'Not authenticated' });

  if (urlPath === '/admin/logout') {
    const t = cookies(req).mist_admin; delete DB.sessions[t]; save();
    res.setHeader('Set-Cookie', 'mist_admin=; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  if (urlPath === '/admin/state' && req.method === 'GET') {
    const providers = {};
    for (const [id, p] of Object.entries(DB.providers)) {
      const resolvedKey = keyFor(id);
      const fromEnv = !p.apiKey && !!resolvedKey;
      providers[id] = {
        label: p.label, format: p.format, baseUrl: p.baseUrl || '',
        hasKey: !!resolvedKey, keyMask: mask(resolvedKey),
        fromEnv // true = key came from environment variable, not admin panel
      };
    }
    return send(res, 200, {
      providers, routing: DB.routing,
      systemPrompts: DB.systemPrompts || { mist1: '', mist2: '', mist3: '', stella: '' },
      stellaAssistant: DB.stellaAssistant || 'mist2',
      users: Object.values(DB.users).sort((a, b) => b.lastSeen - a.lastSeen),
      chats: Object.values(DB.chats).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 500),
      projects: Object.values(DB.projects).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
      stats: {
        users: Object.keys(DB.users).length,
        chats: Object.keys(DB.chats).length,
        projects: Object.keys(DB.projects).length,
        banned: Object.values(DB.users).filter(u => u.banned).length
      }
    });
  }

  if (urlPath === '/admin/provider' && req.method === 'POST') {
    const b = await readJson(req);
    if (!b || !b.id) return send(res, 400, { error: 'Missing id' });
    const cur = DB.providers[b.id] || {};
    DB.providers[b.id] = {
      label: b.label || cur.label || b.id,
      format: b.format || cur.format || 'openai',
      baseUrl: b.baseUrl !== undefined ? b.baseUrl : (cur.baseUrl || ''),
      apiKey: (b.apiKey && b.apiKey.trim()) ? b.apiKey.trim() : (cur.apiKey || '')
    };
    save();
    return send(res, 200, { ok: true });
  }
  if (urlPath === '/admin/provider/delete' && req.method === 'POST') {
    const b = await readJson(req);
    delete DB.providers[b.id]; save();
    return send(res, 200, { ok: true });
  }
  if (urlPath === '/admin/routing' && req.method === 'POST') {
    const b = await readJson(req);
    if (b && b.routing) {
      // merge carefully so we don't wipe chains the UI didn't send
      for (const [k, v] of Object.entries(b.routing)) DB.routing[k] = Object.assign({}, DB.routing[k] || {}, v);
      save();
    }
    return send(res, 200, { ok: true });
  }
  if (urlPath === '/admin/stella' && req.method === 'POST') {
    const b = await readJson(req);
    if (b && ['mist1','mist2','mist3'].includes(b.assistant)) {
      DB.stellaAssistant = b.assistant; save();
    }
    return send(res, 200, { ok: true });
  }

  /* Admin Google link — shared account that both Mist AIs can read from.
     Requires GOOGLE_CLIENT_ID/SECRET env vars. Scopes: gmail.readonly,
     calendar.readonly. Only the admin can link this account. */
  if (urlPath === '/admin/google/link-url' && req.method === 'GET') {
    if (!OAUTH.google.clientId) return send(res, 200, { configured: false });
    const state = crypto.randomBytes(12).toString('hex');
    oauthStates[state] = nowMs() + 600e3;
    const redirect = baseUrlFrom(req) + '/admin/google/link-callback';
    const p = new URLSearchParams({
      client_id: OAUTH.google.clientId,
      redirect_uri: redirect,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      state,
      scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly openid email profile'
    });
    return send(res, 200, { url: OAUTH.google.authUrl + '?' + p.toString() });
  }
  if (urlPath === '/admin/google/status' && req.method === 'GET') {
    const link = DB.adminGoogle;
    return send(res, 200, link ? { linked: true, email: link.email } : { linked: false });
  }
  if (urlPath === '/admin/google/unlink' && req.method === 'POST') {
    delete DB.adminGoogle; save();
    return send(res, 200, { ok: true });
  }

  if (urlPath === '/admin/systemprompt' && req.method === 'POST') {
    const b = await readJson(req);
    if (!b || !b.assistant) return send(res, 400, { error: 'Missing assistant' });
    if (!DB.systemPrompts) DB.systemPrompts = {};
    DB.systemPrompts[b.assistant] = (b.prompt || '').slice(0, 40000);
    save();
    return send(res, 200, { ok: true });
  }
  if (urlPath === '/admin/systemprompt' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const a = q.get('assistant');
    return send(res, 200, { prompt: (DB.systemPrompts || {})[a] || '' });
  }
  if (urlPath === '/admin/ban' && req.method === 'POST') {
    const b = await readJson(req);
    const u = DB.users[b.userId];
    if (u) { u.banned = !!b.banned; save(); }
    return send(res, 200, { ok: true });
  }
  if (urlPath === '/admin/user/delete' && req.method === 'POST') {
    const b = await readJson(req);
    delete DB.users[b.userId]; save();
    return send(res, 200, { ok: true });
  }
  if (urlPath === '/admin/chat/delete' && req.method === 'POST') {
    const b = await readJson(req);
    delete DB.chats[b.id]; save();
    return send(res, 200, { ok: true });
  }
  if (urlPath === '/admin/chat/get' && req.method === 'POST') {
    const b = await readJson(req);
    return send(res, 200, DB.chats[b.id] || { error: 'not found' });
  }
  if (urlPath === '/admin/project/delete' && req.method === 'POST') {
    const b = await readJson(req);
    delete DB.projects[b.id]; save();
    return send(res, 200, { ok: true });
  }
  if (urlPath === '/admin/password' && req.method === 'POST') {
    const b = await readJson(req);
    if (!b || !b.password || b.password.length < 4) return send(res, 400, { error: 'Password too short' });
    setPass(b.password);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Unknown admin route' });
}

/* ------------------------------ oauth ------------------------------ */
const oauthStates = {};
function baseUrlFrom(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + PORT);
  return proto + '://' + host;
}
function oauthStart(req, res, provider) {
  const cfg = OAUTH[provider];
  if (!cfg || !cfg.clientId) return send(res, 200, { configured: false }); // website falls back to local account
  const state = crypto.randomBytes(12).toString('hex');
  oauthStates[state] = nowMs() + 600e3;
  const redirect = baseUrlFrom(req) + '/oauth/' + provider + '/callback';
  const p = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirect, scope: cfg.scope, state, response_type: 'code' });
  return send(res, 200, { url: cfg.authUrl + '?' + p.toString() });
}
/* Admin Google link callback — stores tokens for shared AI Google account */
async function adminGoogleCallback(req, res) {
  const cfg = OAUTH.google;
  const base = baseUrlFrom(req);
  const q = new URL(req.url, base).searchParams;
  const code = q.get('code'), state = q.get('state');
  if (!code || !state || !oauthStates[state]) {
    res.writeHead(302, { Location: '/admin' }); return res.end();
  }
  delete oauthStates[state];
  const redirect = base + '/admin/google/link-callback';
  try {
    const tokRes = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId, client_secret: cfg.clientSecret,
        code, redirect_uri: redirect, grant_type: 'authorization_code'
      }).toString()
    });
    const tok = await tokRes.json();
    if (!tok.access_token) {
      res.writeHead(302, { Location: '/admin?google_error=1' }); return res.end();
    }
    // fetch profile
    const prof = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { authorization: 'Bearer ' + tok.access_token }
    }).then(r => r.json()).catch(() => ({}));
    DB.adminGoogle = {
      email: prof.email || 'unknown',
      name: prof.name || '',
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || (DB.adminGoogle && DB.adminGoogle.refreshToken) || '',
      expiresAt: nowMs() + (tok.expires_in || 3600) * 1000,
      linkedAt: nowMs()
    };
    save();
    res.writeHead(302, { Location: '/admin?google_linked=1' }); return res.end();
  } catch (e) {
    res.writeHead(302, { Location: '/admin?google_error=1' }); return res.end();
  }
}

async function oauthCallback(req, res, provider) {
  const cfg = OAUTH[provider];
  const base = baseUrlFrom(req);
  const site = process.env.SITE_URL || base;
  const q = new URL(req.url, base).searchParams;
  const code = q.get('code'), state = q.get('state');
  if (!code || !state || !oauthStates[state]) { res.writeHead(302, { Location: site }); return res.end(); }
  delete oauthStates[state];
  const redirect = base + '/oauth/' + provider + '/callback';
  try {
    const tokRes = await fetch(cfg.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirect, grant_type: 'authorization_code' })
    });
    const tok = await tokRes.json();
    const access = tok.access_token;
    const uRes = await fetch(cfg.userUrl, { headers: { authorization: 'Bearer ' + access, accept: 'application/json', 'user-agent': 'mist' } });
    const profile = await uRes.json();
    const email = profile.email || (profile.login ? profile.login + '@users.noreply.github.com' : 'user@mist.local');
    const name = profile.name || profile.login || (email.split('@')[0]);
    const userId = provider + ':' + (profile.id || profile.sub || email);
    touchUser(userId); DB.users[userId].label = name; DB.users[userId].email = email; save();
    const params = new URLSearchParams({ mist_login: provider, email, name, uid: userId });
    res.writeHead(302, { Location: site + '/?' + params.toString() }); return res.end();
  } catch (e) {
    res.writeHead(302, { Location: site + '/?oauth_error=1' }); return res.end();
  }
}

/* ------------------------------ /api/generate (Mist 3 images) ------------------------------ */
async function handleGenerate(req, res) {
  cors(res);
  const body = await readJson(req);
  if (!body || !body.prompt) return send(res, 400, { error: 'Missing prompt' });
  const userId = req.headers['x-mist-user'] || 'anon';
  const user = touchUser(userId);
  if (user.banned) return send(res, 403, { error: 'Suspended' });

  // Prefer Stability, then Replicate
  const stabKey = keyFor('stability');
  const repKey = keyFor('replicate');

  if (stabKey) {
    try {
      const form = new FormData();
      form.append('prompt', body.prompt);
      form.append('output_format', 'png');
      if (body.aspect) form.append('aspect_ratio', body.aspect);
      const r = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + stabKey, accept: 'image/*' },
        body: form
      });
      if (!r.ok) { const t = await r.text().catch(()=> ''); return send(res, r.status, { error: 'Stability: ' + t.slice(0,200) }); }
      const buf = Buffer.from(await r.arrayBuffer());
      return send(res, 200, { image: 'data:image/png;base64,' + buf.toString('base64'), provider: 'stability' });
    } catch (e) { return send(res, 502, { error: 'Stability request failed: ' + e.message }); }
  }
  if (repKey) {
    try {
      const start = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { authorization: 'Token ' + repKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: body.model || 'black-forest-labs/flux-schnell',
          input: { prompt: body.prompt }
        })
      });
      const p = await start.json();
      if (!p.id) return send(res, 502, { error: 'Replicate: ' + (p.detail || 'unknown') });
      // Poll for completion (max 60s)
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const s = await fetch('https://api.replicate.com/v1/predictions/' + p.id, {
          headers: { authorization: 'Token ' + repKey }
        }).then(r => r.json());
        if (s.status === 'succeeded') {
          const url = Array.isArray(s.output) ? s.output[0] : s.output;
          return send(res, 200, { image: url, provider: 'replicate' });
        }
        if (s.status === 'failed') return send(res, 502, { error: 'Replicate: generation failed' });
      }
      return send(res, 504, { error: 'Replicate: timed out after 60s' });
    } catch (e) { return send(res, 502, { error: 'Replicate request failed: ' + e.message }); }
  }
  return send(res, 503, { error: 'No image provider configured. Add a Stability AI or Replicate key in the admin console.' });
}

/* ------------------------------ workspaces (multi-user accounts) ------------------------------ */
async function handleWorkspace(req, res) {
  cors(res);
  const body = await readJson(req);
  if (!body || !body.action) return send(res, 400, { error: 'Missing action' });
  const userId = req.headers['x-mist-user'] || 'anon';
  const user = touchUser(userId);
  if (user.banned) return send(res, 403, { error: 'Suspended' });

  if (!DB.workspaces) DB.workspaces = {};

  if (body.action === 'create') {
    const id = 'ws_' + uid();
    const invite = uid() + uid();
    DB.workspaces[id] = {
      id, name: body.name || 'My workspace', ownerId: userId,
      memberIds: [userId], inviteToken: invite, createdAt: nowMs()
    };
    save();
    return send(res, 200, { workspace: DB.workspaces[id], inviteUrl: '/join/' + invite });
  }

  if (body.action === 'list') {
    const mine = Object.values(DB.workspaces).filter(w => w.memberIds.includes(userId));
    return send(res, 200, { workspaces: mine });
  }

  if (body.action === 'rename') {
    const w = DB.workspaces[body.id];
    if (!w || w.ownerId !== userId) return send(res, 403, { error: 'Not the owner' });
    w.name = (body.name || '').slice(0, 60) || w.name;
    save();
    return send(res, 200, { workspace: w });
  }

  if (body.action === 'remove_member') {
    const w = DB.workspaces[body.id];
    if (!w || w.ownerId !== userId) return send(res, 403, { error: 'Not the owner' });
    w.memberIds = w.memberIds.filter(m => m !== body.memberId);
    save();
    return send(res, 200, { workspace: w });
  }

  if (body.action === 'delete') {
    const w = DB.workspaces[body.id];
    if (!w || w.ownerId !== userId) return send(res, 403, { error: 'Not the owner' });
    delete DB.workspaces[body.id];
    save();
    return send(res, 200, { ok: true });
  }

  return send(res, 400, { error: 'Unknown action' });
}

async function handleWorkspaceJoin(req, res, token) {
  cors(res);
  const userId = req.headers['x-mist-user'] || 'anon';
  const user = touchUser(userId);
  if (user.banned) return send(res, 403, { error: 'Suspended' });
  const ws = Object.values(DB.workspaces || {}).find(w => w.inviteToken === token);
  if (!ws) return send(res, 404, { error: 'Invalid invite' });
  if (!ws.memberIds.includes(userId)) ws.memberIds.push(userId);
  save();
  return send(res, 200, { workspace: ws });
}

/* ------------------------------ connect (remote control bridge) ------------------------------ */
/* Pattern:
     1. User creates a token in Mist admin (POST /api/connect/token)
     2. On their machine, they run:
          curl -s https://your-mist/connect.sh?token=XYZ | node
        The script starts a Node process that long-polls /api/connect/poll
     3. From Mist chat, "@device do X" -> POST /api/connect/exec with cmd
     4. The device script sees it via poll, runs it, POSTs result back
   The device does the actual execution (shell command, file read, browser open).
   The server is only a message queue with per-token isolation. */

async function handleConnectToken(req, res) {
  cors(res);
  const body = await readJson(req);
  const userId = req.headers['x-mist-user'] || 'anon';
  const user = touchUser(userId);
  if (user.banned) return send(res, 403, { error: 'Suspended' });
  if (!DB.connectTokens) DB.connectTokens = {};
  const token = uid() + uid();
  DB.connectTokens[token] = {
    token, userId, deviceLabel: (body && body.label) || 'My computer',
    createdAt: nowMs(), lastSeen: 0, pending: [], results: {}
  };
  save();
  return send(res, 200, { token, script: 'node -e "' + connectScript(token).replace(/"/g,'\\"') + '"' });
}
function connectScript(token) {
  // The tiny always-running client the user runs on their device
  return `const http=require('https'),{execSync}=require('child_process'),url='${'${'}process.env.MIST_URL||'https://your-mist-server'${'}'}';setInterval(async()=>{try{const r=await fetch(url+'/api/connect/poll?token=${token}');const j=await r.json();for(const c of j.cmds||[]){try{const out=execSync(c.cmd,{timeout:15000}).toString();await fetch(url+'/api/connect/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'${token}',id:c.id,ok:true,output:out.slice(0,4000)})});}catch(e){await fetch(url+'/api/connect/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'${token}',id:c.id,ok:false,output:String(e).slice(0,4000)})});}}}catch{}},2000);console.log('Mist Connect running for token ${token.slice(0,8)}…');`;
}

async function handleConnectExec(req, res) {
  cors(res);
  const body = await readJson(req);
  const userId = req.headers['x-mist-user'] || 'anon';
  if (!body || !body.token || !body.cmd) return send(res, 400, { error: 'Missing token or cmd' });
  const t = DB.connectTokens && DB.connectTokens[body.token];
  if (!t || t.userId !== userId) return send(res, 403, { error: 'Invalid token' });
  const id = uid();
  t.pending.push({ id, cmd: body.cmd, ts: nowMs() });
  save();
  return send(res, 200, { id });
}

async function handleConnectPoll(req, res) {
  cors(res);
  const q = new URL(req.url, 'http://x').searchParams;
  const token = q.get('token');
  const t = DB.connectTokens && DB.connectTokens[token];
  if (!t) return send(res, 404, { error: 'Unknown token' });
  t.lastSeen = nowMs();
  const cmds = t.pending.slice();
  t.pending = [];
  save();
  return send(res, 200, { cmds });
}

async function handleConnectResult(req, res) {
  cors(res);
  const body = await readJson(req);
  const t = DB.connectTokens && DB.connectTokens[body && body.token];
  if (!t) return send(res, 404, { error: 'Unknown token' });
  t.results[body.id] = { ok: body.ok, output: (body.output || '').slice(0, 8000), ts: nowMs() };
  save();
  return send(res, 200, { ok: true });
}

/* ------------------------------ router ------------------------------ */
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  if (req.method === 'OPTIONS') { cors(res); return send(res, 204, ''); }
  if (urlPath === '/api/health') { cors(res); return send(res, 200, { ok: true }); }
  if (urlPath === '/api/stella-config') { cors(res); return send(res, 200, { assistant: DB.stellaAssistant || 'mist2' }); }
  if (urlPath === '/api/chat' && req.method === 'POST') return handleChat(req, res);
  if (urlPath === '/api/sync' && req.method === 'POST') return handleSync(req, res);
  if (urlPath === '/api/generate' && req.method === 'POST') return handleGenerate(req, res);
  if (urlPath === '/api/workspace' && req.method === 'POST') return handleWorkspace(req, res);
  if (urlPath.startsWith('/api/workspace/join/') && req.method === 'POST') return handleWorkspaceJoin(req, res, urlPath.split('/').pop());
  if (urlPath === '/api/connect/token' && req.method === 'POST') return handleConnectToken(req, res);
  if (urlPath === '/api/connect/exec' && req.method === 'POST') return handleConnectExec(req, res);
  if (urlPath === '/api/connect/poll' && req.method === 'GET') return handleConnectPoll(req, res);
  if (urlPath === '/api/connect/result' && req.method === 'POST') return handleConnectResult(req, res);

  // OAuth: /oauth/:provider/url  -> { url }   and   /oauth/:provider/callback
  const oauthUrl = urlPath.match(/^\/oauth\/(github|google)\/url$/);
  if (oauthUrl) { cors(res); return oauthStart(req, res, oauthUrl[1]); }
  const oauthCb = urlPath.match(/^\/oauth\/(github|google)\/callback$/);
  if (oauthCb) return oauthCallback(req, res, oauthCb[1]);

  // Admin Google link callback — stores refresh token so both Mist AIs can read Gmail/Calendar
  if (urlPath === '/admin/google/link-callback') return adminGoogleCallback(req, res);

  if (urlPath === '/admin' || urlPath === '/admin/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(ADMIN_HTML);
  }
  if (urlPath.startsWith('/admin/')) return handleAdminApi(req, res, urlPath);

  // serve the website itself at "/" so everything is one deploy, one origin
  if (urlPath === '/' || urlPath === '/index.html' || urlPath === '/mist.html') {
    try {
      const html = fs.readFileSync(SITE_FILE, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<h2 style="font-family:system-ui;padding:40px">Mist server is running.</h2>' +
        '<p style="font-family:system-ui;padding:0 40px">Put <code>mist.html</code> next to <code>admin-server.js</code> to serve the app here, or open <a href="/admin">/admin</a>.</p>');
    }
  }

  // serve Stellar (the AI browser)
  if (urlPath === '/stellar' || urlPath === '/stellar.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'stellar.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<h2 style="font-family:system-ui;padding:40px">Stellar not found</h2>' +
        '<p style="font-family:system-ui;padding:0 40px">Put <code>stellar.html</code> next to <code>admin-server.js</code> to serve it here.</p>');
    }
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log('\n  Mist admin server running');
  console.log('  Console:  http://localhost:' + PORT + '/admin');
  console.log('  Chat API: http://localhost:' + PORT + '/api/chat');
  console.log('  Data:     ' + DATA_FILE);
  if (!fs.existsSync(DATA_FILE)) { save(); console.log('  First run — admin password: ' + FIRST_RUN_PASSWORD + '  (change it in the console)'); }
  console.log('');
});

/* ------------------------------ admin console UI ------------------------------ */
const ADMIN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Mist Admin</title>
<style>
:root{--bg:#0E0D0B;--surface:#161513;--s2:#1D1B18;--s3:#26231F;--border:#2C2925;--text:#F4F0E9;--muted:#948C7F;--brand:#FA500F;--grad:linear-gradient(90deg,#FFD800,#FF8205,#FA500F);--ok:#1F8A5B;--danger:#C0341B;--r:12px}
*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);font-size:14px}
button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}
a{color:var(--brand)}
.login{min-height:100dvh;display:grid;place-items:center;padding:20px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:22px}
.login .card{width:min(380px,100%)}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.02em}
.mark{width:26px;height:26px;border-radius:7px;background:var(--grad);display:inline-block;vertical-align:-6px;margin-right:8px}
.muted{color:var(--muted);font-size:13px}
input,select,textarea{width:100%;padding:10px 12px;background:var(--s2);border:1px solid var(--border);border-radius:8px;margin-top:6px}
textarea{min-height:70px;resize:vertical;font-family:ui-monospace,monospace;font-size:12.5px}
.btn{background:var(--s2);border:1px solid var(--border);border-radius:999px;padding:8px 16px;font-weight:600}
.btn:hover{border-color:var(--brand)}
.btn.grad{background:var(--grad);color:#1a0e00;border:0}
.btn.danger{color:#ff8a72;border-color:#5a2a20}
.btn.sm{padding:5px 11px;font-size:12.5px}
.wrap{max-width:1080px;margin:0 auto;padding:20px}
.top{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg);z-index:5}
.top .sp{flex:1}
.tabs{display:flex;gap:4px;margin:18px 0;flex-wrap:wrap}
.tab{padding:8px 15px;border-radius:999px;background:var(--s2);border:1px solid var(--border);color:var(--muted);font-weight:600}
.tab.on{background:var(--s3);color:var(--text);border-color:var(--brand)}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:8px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px}
.stat b{font-size:26px;display:block;letter-spacing:-.02em}
.stat span{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.pane{display:none}.pane.on{display:block}
.badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px}
.badge.ok{background:#0f2a1e;color:#7EE2A8}.badge.no{background:var(--s3);color:var(--muted)}.badge.ban{background:#2a1512;color:#ff8a72}
.field{margin-bottom:12px}.field label{font-weight:600;font-size:13px}
.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:120px}
.prov{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px;margin-bottom:10px}
.prov h4{margin:0 0 8px;font-size:14px}
#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--text);color:var(--bg);padding:9px 16px;border-radius:999px;opacity:0;transition:.2s;font-weight:600}
#toast.on{opacity:1;transform:translateX(-50%)}
pre{background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:12px;overflow:auto;font-size:12px;white-space:pre-wrap}
dialog{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:var(--r);max-width:640px;width:92%;padding:0}
dialog::backdrop{background:rgba(0,0,0,.6)}
.dlg-h{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
.dlg-b{padding:18px;max-height:64dvh;overflow:auto}
</style></head><body>

<div class="login" id="login">
  <div class="card">
    <h1><span class="mark"></span>Mist Admin</h1>
    <p class="muted">Enter your admin password to continue.</p>
    <input id="pw" type="password" placeholder="Password" onkeydown="if(event.key==='Enter')doLogin()">
    <button class="btn grad" style="width:100%;margin-top:12px" onclick="doLogin()">Unlock</button>
    <p class="muted" id="loginErr" style="color:#ff8a72;margin-bottom:0"></p>
  </div>
</div>

<div id="app" style="display:none">
  <div class="top">
    <h1 style="font-size:17px"><span class="mark"></span>Mist Admin</h1>
    <span class="sp"></span>
    <button class="btn sm" onclick="loadState()">Refresh</button>
    <button class="btn sm" onclick="doLogout()">Log out</button>
  </div>
  <div class="wrap">
    <div class="stats" id="stats"></div>
    <div class="tabs">
      <button class="tab on" data-t="keys">Keys &amp; Models</button>
      <button class="tab" data-t="users">Users</button>
      <button class="tab" data-t="chats">Chats</button>
      <button class="tab" data-t="projects">Projects</button>
      <button class="tab" data-t="settings">Settings</button>
    </div>

    <div class="pane on" id="pane-keys"></div>
    <div class="pane" id="pane-users"></div>
    <div class="pane" id="pane-chats"></div>
    <div class="pane" id="pane-projects"></div>
    <div class="pane" id="pane-settings"></div>
  </div>
</div>

<dialog id="dlg"><div class="dlg-h"><b id="dlgTitle">Chat</b><button class="btn sm" onclick="dlg.close()">Close</button></div><div class="dlg-b" id="dlgBody"></div></dialog>
<div id="toast"></div>

<script>
let STATE = null;
const $ = s => document.querySelector(s);
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(m){const t=$('#toast');t.textContent=m;t.classList.add('on');setTimeout(()=>t.classList.remove('on'),1800);}
async function api(path, body){
  const r = await fetch('/admin'+path, body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
  if(r.status===401){show('login');throw new Error('auth');}
  return r.json();
}
function show(which){ $('#login').style.display = which==='login'?'grid':'none'; $('#app').style.display = which==='app'?'block':'none'; }

async function doLogin(){
  const r = await fetch('/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('#pw').value})});
  if(r.ok){ show('app'); loadState(); } else { $('#loginErr').textContent='Wrong password'; }
}
async function doLogout(){ await fetch('/admin/logout'); show('login'); }

document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on',x===t));
  document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('on',p.id==='pane-'+t.dataset.t));
});

async function loadState(){
  try{ STATE = await api('/state'); }catch{ return; }
  const s = STATE.stats;
  $('#stats').innerHTML =
    stat(s.users,'Users')+stat(s.chats,'Chats')+stat(s.projects,'Projects')+stat(s.banned,'Banned');
  renderKeys(); renderUsers(); renderChats(); renderProjects(); renderSettings();
}
const stat=(n,l)=>'<div class="stat"><b>'+n+'</b><span>'+l+'</span></div>';

/* KEYS & MODELS */
function provOpts(sel){ return Object.keys(STATE.providers).map(id=>'<option value="'+id+'"'+(id===sel?' selected':'')+'>'+esc(STATE.providers[id].label)+'</option>').join(''); }
function chainEditor(chainId, chain){
  const rows = (chain||[]).map((f,i)=>
    '<div class="row" style="margin-top:6px;align-items:center">'+
    '<div><select id="'+chainId+'-p-'+i+'">'+provOpts(f.provider)+'</select></div>'+
    '<div><input id="'+chainId+'-m-'+i+'" value="'+esc(f.model||'')+'" placeholder="model id e.g. grok-4.5"></div>'+
    '<button class="btn sm danger" style="flex:none;margin-top:6px" onclick="removeChainRow(\\''+chainId+'\\','+i+')">✕</button></div>').join('');
  return '<div id="'+chainId+'-rows">'+rows+'</div>'+
    '<button class="btn sm" style="margin-top:8px" onclick="addChainRow(\\''+chainId+'\\')">+ Add model (max 6)</button>';
}
function collectChain(chainId){
  const out=[]; let i=0;
  while(document.getElementById(chainId+'-p-'+i)){
    const m=document.getElementById(chainId+'-m-'+i).value.trim();
    if(m) out.push({provider:document.getElementById(chainId+'-p-'+i).value,model:m});
    i++;
  }
  return out;
}
function addChainRow(chainId){
  const rows=document.getElementById(chainId+'-rows');
  const i=rows.querySelectorAll('.row').length;
  if(i>=6){toast('Max 6 models per chain');return;}
  const div=document.createElement('div');div.className='row';div.style.marginTop='6px';div.style.alignItems='center';
  div.innerHTML='<div><select id="'+chainId+'-p-'+i+'">'+provOpts(Object.keys(STATE.providers)[0])+'</select></div>'+
    '<div><input id="'+chainId+'-m-'+i+'" placeholder="model id" style="margin-top:6px"></div>'+
    '<button class="btn sm danger" style="flex:none;margin-top:6px" onclick="removeChainRow(\\''+chainId+'\\','+i+')">✕</button>';
  rows.appendChild(div);
}
function removeChainRow(chainId,i){
  const el=document.getElementById(chainId+'-p-'+i);
  if(el){ const r=el.closest('.row'); if(r) r.remove(); }
}

function renderKeys(){
  const P=STATE.providers, R=STATE.routing, SP=STATE.systemPrompts||{};
  let html='<div class="card"><h3 style="margin-top:0">API providers</h3>'+
    '<p class="muted">Keys are stored on this server only. Paste a key to set or replace it; leave blank to keep current.</p>';
  for(const [id,p] of Object.entries(P)){
    html+='<div class="prov"><h4>'+esc(p.label)+' <span class="muted">('+esc(id)+' · '+esc(p.format)+')</span> '+
      (p.hasKey?'<span class="badge ok">'+(p.fromEnv?'env var':'key set')+' '+esc(p.keyMask)+'</span>':'<span class="badge no">no key</span>')+'</h4>'+
      '<div class="row">'+
      '<div><label>Label</label><input value="'+esc(p.label)+'" id="pl-'+id+'"></div>'+
      '<div><label>Format</label><select id="pf-'+id+'">'+['openai','anthropic','gemini'].map(f=>'<option'+(f===p.format?' selected':'')+'>'+f+'</option>').join('')+'</select></div>'+
      '</div>'+
      '<div class="field"><label>Base URL <span class="muted">(OpenAI-format only)</span></label><input value="'+esc(p.baseUrl)+'" id="pb-'+id+'" placeholder="https://..."></div>'+
      '<div class="field"><label>API key</label><input type="password" id="pk-'+id+'" placeholder="'+(p.hasKey?'•••• leave blank to keep':'paste key here')+'"></div>'+
      '<button class="btn sm grad" onclick="saveProvider(\\''+id+'\\')">Save</button> '+
      '<button class="btn sm danger" onclick="delProvider(\\''+id+'\\')">Remove</button></div>';
  }
  html+='<button class="btn sm" style="margin-top:8px" onclick="addProvider()">+ Add provider</button></div>';

  // Mist 1 routing
  const r1=R.mist1||{};
  html+='<div class="card" style="margin-top:14px"><h3 style="margin-top:0">Mist 1 — routing</h3>'+
    '<p class="muted">Single model for everyday questions.</p>'+
    '<div class="row"><div><label>Provider</label><select id="m1-p">'+provOpts(r1.provider)+'</select></div>'+
    '<div><label>Model</label><input id="m1-m" value="'+esc(r1.model||'')+'" placeholder="google/gemma-4-31b-it"></div></div>'+
    '<button class="btn grad" style="margin-top:12px" onclick="saveMist1Routing()">Save Mist 1 routing</button></div>';

  // Mist 2 routing — two chains + global fallbacks
  const r2=R.mist2||{};
  html+='<div class="card" style="margin-top:14px"><h3 style="margin-top:0">Mist 2 — routing (up to 6 models per chain)</h3>'+
    '<p class="muted">Coding chain runs for text/code. Multimodal chain runs when the user sends a URL, image or video. Max 6 models each — tried in order, auto-falls to next on error or rate limit.</p>'+

    '<h4 style="margin:14px 0 6px">🧠 Coding chain</h4>'+
    chainEditor('m2-code', r2.codingChain||[])+

    '<h4 style="margin:14px 0 6px">🎥 Multimodal chain (URLs, images, video)</h4>'+
    chainEditor('m2-multi', r2.multimodalChain||[])+

    '<h4 style="margin:14px 0 6px">🔁 Global fallbacks (tried after both chains fail)</h4>'+
    chainEditor('m2-fb', r2.fallbacks||[])+

    '<button class="btn grad" style="margin-top:14px" onclick="saveMist2Routing()">Save Mist 2 routing</button></div>';

  // Stella (Stellar's AI) — pick which assistant powers her
  const stellaAssist = STATE.stellaAssistant || 'mist2';
  html+='<div class="card" style="margin-top:14px"><h3 style="margin-top:0">Stella (Stellar\'s AI)</h3>'+
    '<p class="muted">Which Mist assistant powers Stella in the Stellar browser. She uses whichever key/model that assistant is set up with above.</p>'+
    '<div class="row"><div><label>Assistant</label><select id="stella-a">'+
      ['mist1','mist2','mist3'].map(a=>'<option value="'+a+'"'+(a===stellaAssist?' selected':'')+'>'+a.replace(/^./,c=>c.toUpperCase())+'</option>').join('')+
    '</select></div></div>'+
    '<button class="btn grad" style="margin-top:12px" onclick="saveStella()">Save Stella routing</button></div>';

  // Admin-linked Google account (shared across Mist AIs)
  html+='<div class="card" style="margin-top:14px"><h3 style="margin-top:0">Shared Google account</h3>'+
    '<p class="muted">Link one Google account here. Mist 1 and Mist 2 will be able to read Gmail and Calendar from it (via Google\'s official API — never by clicking their UI). Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars on this server.</p>'+
    '<div id="google-status"><em class="muted">Loading…</em></div>'+
    '<div style="display:flex;gap:8px;margin-top:10px" id="google-actions"></div></div>';

  // System prompts
  html+='<div class="card" style="margin-top:14px"><h3 style="margin-top:0">System prompts</h3>'+
    '<p class="muted">Override the built-in personality for each assistant. You can paste or type a prompt, or upload a .txt file. Leave blank to use the default built-in prompt.</p>'+

    '<h4 style="margin:14px 0 6px">Mist 1 system prompt</h4>'+
    '<textarea id="sp-mist1" style="width:100%;min-height:140px;background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:10px;font-family:monospace;font-size:12px;color:var(--text)">'+esc(SP.mist1||'')+'</textarea>'+
    '<div style="display:flex;gap:8px;margin-top:6px">'+
    '<label class="btn sm" style="cursor:pointer">Upload .txt <input type="file" accept=".txt" style="display:none" onchange="loadPromptFile(this,\\'mist1\\')"></label>'+
    '<button class="btn sm grad" onclick="savePrompt(\\'mist1\\')">Save Mist 1 prompt</button>'+
    '<button class="btn sm danger" onclick="clearPrompt(\\'mist1\\')">Reset to default</button></div>'+

    '<h4 style="margin:14px 0 6px">Mist 2 system prompt</h4>'+
    '<textarea id="sp-mist2" style="width:100%;min-height:140px;background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:10px;font-family:monospace;font-size:12px;color:var(--text)">'+esc(SP.mist2||'')+'</textarea>'+
    '<div style="display:flex;gap:8px;margin-top:6px">'+
    '<label class="btn sm" style="cursor:pointer">Upload .txt <input type="file" accept=".txt" style="display:none" onchange="loadPromptFile(this,\\'mist2\\')"></label>'+
    '<button class="btn sm grad" onclick="savePrompt(\\'mist2\\')">Save Mist 2 prompt</button>'+
    '<button class="btn sm danger" onclick="clearPrompt(\\'mist2\\')">Reset to default</button></div></div>';

  $('#pane-keys').innerHTML=html;
  refreshGoogleStatus();
}
async function refreshGoogleStatus(){
  const s = document.getElementById('google-status');
  const a = document.getElementById('google-actions');
  if (!s || !a) return;
  try {
    const r = await fetch('/admin/google/status').then(r=>r.json());
    if (r.linked) {
      s.innerHTML = '<span class="badge ok">Linked</span> <b>'+esc(r.email)+'</b>';
      a.innerHTML = '<button class="btn sm danger" onclick="unlinkGoogle()">Unlink</button>';
    } else {
      s.innerHTML = '<span class="badge no">Not linked</span>';
      const u = await fetch('/admin/google/link-url').then(r=>r.json());
      if (u.configured === false) {
        a.innerHTML = '<span class="muted" style="font-size:12.5px">Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> env vars, then reload.</span>';
      } else {
        a.innerHTML = '<a class="btn sm grad" href="'+u.url+'">Link Google account</a>';
      }
    }
  } catch { s.innerHTML = '<em class="muted">Status unavailable</em>'; }
}
async function unlinkGoogle(){
  if (!confirm('Unlink the shared Google account?')) return;
  await fetch('/admin/google/unlink',{method:'POST'});
  refreshGoogleStatus();
}

function loadPromptFile(input, assistant){
  const f=input.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=e=>{ document.getElementById('sp-'+assistant).value=e.target.result; toast('File loaded — click Save to apply'); };
  r.readAsText(f);
}
async function savePrompt(assistant){
  const prompt=document.getElementById('sp-'+assistant).value;
  await api('/systemprompt',{assistant,prompt});
  toast('Prompt saved for '+assistant);
}
async function clearPrompt(assistant){
  if(!confirm('Reset to built-in prompt?'))return;
  document.getElementById('sp-'+assistant).value='';
  await api('/systemprompt',{assistant,prompt:''});
  toast('Reset to default');
}
async function saveMist1Routing(){
  const r={mist1:{provider:$('#m1-p').value,model:$('#m1-m').value.trim(),fallbacks:[]}};
  await api('/routing',{routing:r}); toast('Mist 1 routing saved'); loadState();
}
async function saveMist2Routing(){
  const r={mist2:{
    codingChain:collectChain('m2-code'),
    multimodalChain:collectChain('m2-multi'),
    fallbacks:collectChain('m2-fb')
  }};
  await api('/routing',{routing:r}); toast('Mist 2 routing saved'); loadState();
}
async function saveStella(){
  await api('/stella',{assistant:$('#stella-a').value});
  toast('Stella routing saved'); loadState();
}
async function saveProvider(id){
  await api('/provider',{id,label:$('#pl-'+id).value,format:$('#pf-'+id).value,baseUrl:$('#pb-'+id).value,apiKey:$('#pk-'+id).value});
  toast('Provider saved'); loadState();
}
async function delProvider(id){ if(!confirm('Remove provider '+id+'?'))return; await api('/provider/delete',{id}); toast('Removed'); loadState(); }
async function addProvider(){
  const id=prompt('Provider id (e.g. groq, together, openrouter)'); if(!id) return;
  await api('/provider',{id:id.trim(),label:id,format:'openai',baseUrl:'',apiKey:''}); loadState();
}

/* USERS */
function renderUsers(){
  const rows = STATE.users.map(u=>'<tr><td>'+esc(u.id)+'</td>'+
    '<td>'+new Date(u.firstSeen).toLocaleDateString()+'</td>'+
    '<td>'+new Date(u.lastSeen).toLocaleString()+'</td>'+
    '<td>'+u.messages+'</td>'+
    '<td>'+(u.banned?'<span class="badge ban">Banned</span>':'<span class="badge ok">Active</span>')+'</td>'+
    '<td style="text-align:right"><button class="btn sm" onclick="ban(\\''+esc(u.id)+'\\','+(!u.banned)+')">'+(u.banned?'Unban':'Ban')+'</button> '+
    '<button class="btn sm danger" onclick="delUser(\\''+esc(u.id)+'\\')">Delete</button></td></tr>').join('');
  $('#pane-users').innerHTML = '<div class="card"><h3 style="margin-top:0">Users</h3><p class="muted">Every visitor gets an anonymous id from their browser. Banning blocks that id from all chat requests immediately.</p>'+
    '<table><thead><tr><th>User id</th><th>First seen</th><th>Last seen</th><th>Msgs</th><th>Status</th><th></th></tr></thead><tbody>'+(rows||'<tr><td colspan=6 class=muted>No users yet.</td></tr>')+'</tbody></table></div>';
}
async function ban(userId,banned){ await api('/ban',{userId,banned}); toast(banned?'User banned':'User unbanned'); loadState(); }
async function delUser(userId){ if(!confirm('Delete this user record?'))return; await api('/user/delete',{userId}); loadState(); }

/* CHATS */
function renderChats(){
  const rows = STATE.chats.map(c=>'<tr><td>'+esc(c.title||'Untitled')+'</td>'+
    '<td>'+esc(c.assistant||'')+'</td><td>'+esc((c.userId||'').slice(0,12))+'</td>'+
    '<td>'+((c.messages&&c.messages.length)||0)+'</td>'+
    '<td>'+(c.updatedAt?new Date(c.updatedAt).toLocaleString():'')+'</td>'+
    '<td style="text-align:right"><button class="btn sm" onclick="viewChat(\\''+c.id+'\\')">View</button> '+
    '<button class="btn sm danger" onclick="delChat(\\''+c.id+'\\')">Delete</button></td></tr>').join('');
  $('#pane-chats').innerHTML='<div class="card"><h3 style="margin-top:0">Chats</h3><p class="muted">Every conversation that passes through the server, newest first (last 500).</p>'+
    '<table><thead><tr><th>Title</th><th>Model</th><th>User</th><th>Msgs</th><th>Updated</th><th></th></tr></thead><tbody>'+(rows||'<tr><td colspan=6 class=muted>No chats yet.</td></tr>')+'</tbody></table></div>';
}
async function viewChat(id){
  const c = await api('/chat/get',{id});
  $('#dlgTitle').textContent = c.title||'Chat';
  $('#dlgBody').innerHTML = (c.messages||[]).map(m=>'<div style="margin-bottom:12px"><b style="color:var(--brand)">'+esc(m.role)+'</b><pre>'+esc(m.content)+'</pre></div>').join('')||'<p class=muted>Empty</p>';
  $('#dlg').showModal();
}
async function delChat(id){ if(!confirm('Delete this chat?'))return; await api('/chat/delete',{id}); loadState(); }

/* PROJECTS */
function renderProjects(){
  const rows = STATE.projects.map(p=>'<tr><td>'+esc(p.name)+'</td><td>'+esc((p.userId||'').slice(0,12))+'</td>'+
    '<td>'+esc((p.instructions||'').slice(0,80))+'</td>'+
    '<td style="text-align:right"><button class="btn sm danger" onclick="delProject(\\''+p.id+'\\')">Delete</button></td></tr>').join('');
  $('#pane-projects').innerHTML='<div class="card"><h3 style="margin-top:0">Projects</h3>'+
    '<table><thead><tr><th>Name</th><th>User</th><th>Instructions</th><th></th></tr></thead><tbody>'+(rows||'<tr><td colspan=4 class=muted>No projects synced yet.</td></tr>')+'</tbody></table></div>';
}
async function delProject(id){ if(!confirm('Delete this project?'))return; await api('/project/delete',{id}); loadState(); }

/* SETTINGS */
function renderSettings(){
  $('#pane-settings').innerHTML='<div class="card"><h3 style="margin-top:0">Change admin password</h3>'+
    '<div class="field"><label>New password</label><input type="password" id="newpw" placeholder="At least 4 characters"></div>'+
    '<button class="btn grad" onclick="changePw()">Update password</button></div>'+
    '<div class="card" style="margin-top:14px"><h3 style="margin-top:0">Connect the website</h3>'+
    '<p class="muted">In Mist open Admin console &rarr; Models and set the chat endpoint to this server:</p>'+
    '<pre>'+location.origin+'/api/chat</pre>'+
    '<p class="muted">The website also needs to send a user id header so bans work. That hook is already in the updated mist.html.</p></div>';
}
async function changePw(){ const pw=$('#newpw').value; if(pw.length<4)return toast('Too short'); await api('/password',{password:pw}); toast('Password updated'); $('#newpw').value=''; }

/* boot: try to load; if 401 we show login */
(async()=>{ try{ await loadState(); show('app'); }catch{ show('login'); } })();
</script>
</body></html>`;
