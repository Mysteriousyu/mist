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
      groq:       { label: 'Groq (⚡ FASTEST)',format: 'openai',    baseUrl: 'https://api.groq.com/openai/v1/chat/completions', apiKey: '',
                    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'] },
      nim:        { label: 'NVIDIA NIM',       format: 'openai',    baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions', apiKey: '',
                    models: ['google/gemma-4-31b-it', 'meta/llama-3.1-405b-instruct', 'meta/llama-3.1-70b-instruct', 'mistralai/mixtral-8x22b-instruct-v0.1'] },
      openai:     { label: 'OpenAI (ChatGPT)', format: 'openai',    baseUrl: 'https://api.openai.com/v1/chat/completions', apiKey: '',
                    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini', 'o3-mini'] },
      anthropic:  { label: 'Anthropic (Claude)',format: 'anthropic', baseUrl: '', apiKey: '',
                    models: ['claude-fable-5-1', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] },
      gemini:     { label: 'Google Gemini',    format: 'gemini',    baseUrl: '', apiKey: '',
                    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'] },
      xai:        { label: 'xAI (Grok)',       format: 'openai',    baseUrl: 'https://api.x.ai/v1/chat/completions', apiKey: '',
                    models: ['grok-4.5', 'grok-3', 'grok-3-mini', 'grok-2'] },
      mistral:    { label: 'Mistral',          format: 'openai',    baseUrl: 'https://api.mistral.ai/v1/chat/completions', apiKey: '',
                    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest'] },
      deepseek:   { label: 'DeepSeek',         format: 'openai',    baseUrl: 'https://api.deepseek.com/chat/completions', apiKey: '',
                    models: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'] },
      kimi:       { label: 'Kimi (Moonshot)',  format: 'openai',    baseUrl: 'https://api.moonshot.ai/v1/chat/completions', apiKey: '' },
      perplexity: { label: 'Perplexity',       format: 'openai',    baseUrl: 'https://api.perplexity.ai/chat/completions', apiKey: '',
                    models: ['sonar-pro', 'sonar', 'sonar-reasoning-pro', 'sonar-reasoning'] },
      qwen:       { label: 'Qwen (Alibaba)',   format: 'openai',    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey: '',
                    models: ['qwen3.8-max', 'qwen-max', 'qwen-plus', 'qwen-turbo'] },
      /* New providers */
      huggingface:{ label: 'Hugging Face',     format: 'openai',    baseUrl: 'https://api-inference.huggingface.co/v1/chat/completions', apiKey: '',
                    models: ['meta-llama/Llama-3.1-70B-Instruct', 'mistralai/Mixtral-8x7B-Instruct-v0.1', 'microsoft/Phi-3-mini-4k-instruct', 'google/gemma-2-9b-it'] },
      together:   { label: 'Together AI',      format: 'openai',    baseUrl: 'https://api.together.xyz/v1/chat/completions', apiKey: '',
                    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'mistralai/Mixtral-8x22B-Instruct-v0.1', 'Qwen/Qwen2.5-72B-Instruct-Turbo'] },
      fireworks:  { label: 'Fireworks AI',     format: 'openai',    baseUrl: 'https://api.fireworks.ai/inference/v1/chat/completions', apiKey: '',
                    models: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/mixtral-8x22b-instruct'] },
      openrouter: { label: 'OpenRouter',       format: 'openai',    baseUrl: 'https://openrouter.ai/api/v1/chat/completions', apiKey: '' },
      vercel:     { label: 'Vercel AI',        format: 'openai',    baseUrl: 'https://api.vercel.ai/v1/chat/completions', apiKey: '',
                    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'gpt-4o', 'gpt-4o-mini'] },
      cohere:     { label: 'Cohere',           format: 'openai',    baseUrl: 'https://api.cohere.com/v2/chat', apiKey: '',
                    models: ['command-r-plus', 'command-r', 'command-light'] },
      sambanova:  { label: 'SambaNova',        format: 'openai',    baseUrl: 'https://api.sambanova.ai/v1/chat/completions', apiKey: '',
                    models: ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-8B-Instruct'] },
      cerebras:   { label: 'Cerebras (⚡ FAST)',format: 'openai',    baseUrl: 'https://api.cerebras.ai/v1/chat/completions', apiKey: '', 
                    models: ['llama-3.3-70b', 'llama-3.1-8b', 'llama-3.1-70b'] },
      lepton:     { label: 'Lepton AI',        format: 'openai',    baseUrl: 'https://llama3-2-3b.lepton.run/api/v1/chat/completions', apiKey: '' },
      ai21:       { label: 'AI21 (Jamba)',     format: 'openai',    baseUrl: 'https://api.ai21.com/studio/v1/chat/completions', apiKey: '',
                    models: ['jamba-1.5-large', 'jamba-1.5-mini'] },
      /* Image/video providers for Omni */
      stability:  { label: 'Stability AI (images)', format: 'stability', baseUrl: 'https://api.stability.ai/v2beta/stable-image/generate/core', apiKey: '' },
      fal:        { label: 'Fal.ai (⚡ FAST images)', format: 'openai', baseUrl: 'https://queue.fal.run/fal-ai/fast-sdxl', apiKey: '' },
      replicate:  { label: 'Replicate (images/video)', format: 'replicate', baseUrl: 'https://api.replicate.com/v1/predictions', apiKey: '' }
    },
    routing: {
      pluto: { provider: 'groq', model: 'llama-3.3-70b-versatile', fallbacks: [
        { provider: 'cerebras', model: 'llama-3.3-70b' },
        { provider: 'together', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
        { provider: 'mistral', model: 'mistral-large-latest' },
        { provider: 'nim', model: 'google/gemma-4-31b-it' }
      ] },
      /* Mist 2 has two chains:
         - codingChain: used for plain text / coding (up to 6 keys)
         - multimodalChain: used when the user sends media or a URL  */
      sonar: {
        codingChain: [
          { provider: 'vercel', model: 'claude-opus-4-8' },
          { provider: 'anthropic', model: 'claude-fable-5-1' },
          { provider: 'cerebras', model: 'llama-3.3-70b' },
          { provider: 'together', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
          { provider: 'mistral', model: 'mistral-large-latest' }
        ],
        multimodalChain: [
          { provider: 'gemini', model: 'gemini-2.0-flash' },
          { provider: 'openai', model: 'gpt-4o' }
        ],
        fallbacks: []
      },
      /* Mist 3 is a chat model that crafts prompts. The actual image generation
         happens via /api/generate route, using stability/replicate. */
      omni: { provider: 'gemini', model: 'gemini-2.0-flash', fallbacks: [
        { provider: 'openai', model: 'gpt-4o' },
        { provider: 'mistral', model: 'mistral-large-latest' },
        { provider: 'cerebras', model: 'llama-3.3-70b' }
      ] }
    },
    /* Custom system prompts — leave blank to use built-in prompts */
    systemPrompts: { pluto: '', sonar: '', omni: '', stella: '' },
    /* Which assistant Stella uses (pluto/sonar/omni). Falls back to sonar. */
    stellaAssistant: 'sonar',
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
  if (assistant === 'sonar') {
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

  const assistant = ['pluto','sonar','omni'].includes(body.assistant) ? body.assistant : 'pluto';
  const messages = body.messages.slice(-24);
  const targets = resolveTargets(assistant, messages);
  if (!targets.length) return send(res, 503, { error: 'No API key configured for ' + assistant + '. Set one in the admin console → Keys & Models.' });

  const customPrompt = (DB.systemPrompts || {})[assistant];
  const basePrompt = (customPrompt && customPrompt.trim()) ? customPrompt.trim() : (body.system || 'You are a helpful assistant.');
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Quick web search — only if the question needs current info, hard 1.5s timeout
  let searchContext = '';
  const lastMsg = messages[messages.length - 1];
  const lastText = (typeof lastMsg?.content === 'string' ? lastMsg.content : '').toLowerCase();
  const needsSearch = /(today|latest|recent|current|news|weather|score|price|update|who won|what happened|right now|this week|this month|2025|2026)/i.test(lastText);

  if (needsSearch && lastText.length > 8) {
    try {
      const q = encodeURIComponent(typeof lastMsg.content === 'string' ? lastMsg.content.slice(0, 100) : '');
      const sr = await fetch('https://api.duckduckgo.com/?q=' + q + '&format=json&no_html=1&skip_disambig=1', {
        signal: AbortSignal.timeout(1500)
      });
      if (sr.ok) {
        const sj = await sr.json();
        const bits = [];
        if (sj.Abstract) bits.push(sj.Abstract);
        if (sj.Answer) bits.push(sj.Answer);
        if (bits.length) searchContext = '\n\n[Web info]: ' + bits.join(' ');
      }
    } catch { /* timed out or failed — continue without search */ }
  }

  const system = basePrompt + '\n\nToday is ' + dateStr + '.' + searchContext;
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
        fromEnv, // true = key came from environment variable, not admin panel
        models: p.models || null
      };
    }
    return send(res, 200, {
      providers, routing: DB.routing,
      systemPrompts: DB.systemPrompts || { pluto: '', sonar: '', omni: '', stella: '' },
      stellaAssistant: DB.stellaAssistant || 'sonar',
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
    if (b && ['pluto','sonar','omni'].includes(b.assistant)) {
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

  const togetherKey = keyFor('together');
  const openaiKey   = keyFor('openai');
  const geminiKey   = keyFor('gemini');
  const falKey      = keyFor('fal');
  const stabKey     = keyFor('stability');
  const repKey      = keyFor('replicate');
  const hfKey       = keyFor('huggingface');

  // ==================== FREE PROVIDERS (no key / no credits needed) ====================

  // 1. Pollinations.ai — completely FREE, no API key, uses FLUX
  try {
    const encoded = encodeURIComponent(body.prompt);
    const seed = Math.floor(Math.random() * 999999);
    const polUrl = 'https://image.pollinations.ai/prompt/' + encoded + '?width=1024&height=768&seed=' + seed + '&nologo=true&model=flux';
    const r = await fetch(polUrl);
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 1000) {
        return send(res, 200, { image: 'data:image/png;base64,' + buf.toString('base64'), provider: 'pollinations' });
      }
    }
    console.error('Pollinations returned non-image or failed');
  } catch (e) { console.error('Pollinations failed:', e.message); }

  // 2. Stable Horde — FREE, community GPUs, no API key needed (anonymous)
  try {
    const startR = await fetch('https://stablehorde.net/api/v2/generate/async', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'apikey': '0000000000' },
      body: JSON.stringify({
        prompt: body.prompt,
        params: { steps: 20, width: 1024, height: 768, cfg_scale: 7 },
        nsfw: false, censor_nsfw: true,
        models: ['FLUX.1 [schnell]']
      })
    });
    const startJ = await startR.json();
    if (startJ.id) {
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const checkR = await fetch('https://stablehorde.net/api/v2/generate/check/' + startJ.id);
        const checkJ = await checkR.json();
        if (checkJ.done) {
          const statusR = await fetch('https://stablehorde.net/api/v2/generate/status/' + startJ.id);
          const statusJ = await statusR.json();
          if (statusJ.generations && statusJ.generations[0] && statusJ.generations[0].img) {
            return send(res, 200, { image: statusJ.generations[0].img, provider: 'stablehorde' });
          }
          break;
        }
        if (checkJ.faulted) break;
      }
    }
    console.error('Stable Horde: timed out or failed');
  } catch (e) { console.error('Stable Horde failed:', e.message); }

  // 3. AirForce API — FREE, no key needed, multiple models
  try {
    const afUrl = 'https://api.airforce/v1/images/generations';
    const r = await fetch(afUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'flux',
        prompt: body.prompt,
        size: '1024x768'
      })
    });
    if (r.ok) {
      const j = await r.json();
      if (j.data && j.data[0] && j.data[0].url) {
        return send(res, 200, { image: j.data[0].url, provider: 'airforce' });
      }
    }
    console.error('AirForce: no image returned');
  } catch (e) { console.error('AirForce failed:', e.message); }

  // ==================== FREE TIER PROVIDERS (need key but have free credits) ====================

  // 4. Together AI — free tier, FLUX model
  if (togetherKey) {
    try {
      const r = await fetch('https://api.together.xyz/v1/images/generations', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + togetherKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'black-forest-labs/FLUX.1-schnell-Free',
          prompt: body.prompt, n: 1, width: 1024, height: 768, steps: 4
        })
      });
      if (!r.ok) { console.error('Together image error:', (await r.text().catch(()=>'')).slice(0,300)); }
      else {
        const j = await r.json();
        if (j.data && j.data[0] && j.data[0].url) return send(res, 200, { image: j.data[0].url, provider: 'together' });
      }
    } catch (e) { console.error('Together image failed:', e.message); }
  }

  // ==================== PAID PROVIDERS (fallbacks) ====================

  // 5. OpenAI DALL-E 3
  if (openaiKey) {
    try {
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + openaiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'dall-e-3', prompt: body.prompt, n: 1, size: '1024x1024', quality: 'standard' })
      });
      if (!r.ok) { console.error('OpenAI DALL-E error:', (await r.text().catch(()=>'')).slice(0,300)); }
      else {
        const j = await r.json();
        if (j.data && j.data[0] && j.data[0].url) return send(res, 200, { image: j.data[0].url, provider: 'openai' });
      }
    } catch (e) { console.error('OpenAI DALL-E failed:', e.message); }
  }

  // 6. Google Gemini Imagen
  if (geminiKey) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:generateImages?key=' + encodeURIComponent(geminiKey), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: body.prompt, config: { numberOfImages: 1 } })
      });
      if (!r.ok) { console.error('Gemini Imagen error:', (await r.text().catch(()=>'')).slice(0,300)); }
      else {
        const j = await r.json();
        if (j.generatedImages && j.generatedImages[0] && j.generatedImages[0].image && j.generatedImages[0].image.imageBytes) {
          return send(res, 200, { image: 'data:image/png;base64,' + j.generatedImages[0].image.imageBytes, provider: 'gemini' });
        }
      }
    } catch (e) { console.error('Gemini Imagen failed:', e.message); }
  }

  // 7. Fal.ai
  if (falKey) {
    try {
      const r = await fetch('https://queue.fal.run/fal-ai/fast-sdxl', {
        method: 'POST',
        headers: { 'authorization': 'key ' + falKey, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: body.prompt, num_inference_steps: 4 })
      });
      if (r.ok) {
        const j = await r.json();
        if (j.images && j.images[0]) return send(res, 200, { image: j.images[0].url, provider: 'fal' });
      }
    } catch (e) { console.error('Fal failed:', e.message); }
  }

  // 8. Stability AI
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
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        return send(res, 200, { image: 'data:image/png;base64,' + buf.toString('base64'), provider: 'stability' });
      }
    } catch (e) { console.error('Stability failed:', e.message); }
  }

  // 9. Replicate
  if (repKey) {
    try {
      const start = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { authorization: 'Token ' + repKey, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 'black-forest-labs/flux-schnell', input: { prompt: body.prompt } })
      });
      const p = await start.json();
      if (p.id) {
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const s = await fetch('https://api.replicate.com/v1/predictions/' + p.id, {
            headers: { authorization: 'Token ' + repKey }
          }).then(r => r.json());
          if (s.status === 'succeeded') {
            const url = Array.isArray(s.output) ? s.output[0] : s.output;
            return send(res, 200, { image: url, provider: 'replicate' });
          }
          if (s.status === 'failed') break;
        }
      }
    } catch (e) { console.error('Replicate failed:', e.message); }
  }

  // 10. HuggingFace
  if (hfKey) {
    try {
      const r = await fetch('https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + hfKey },
        body: Buffer.from(body.prompt)
      });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        return send(res, 200, { image: 'data:image/png;base64,' + buf.toString('base64'), provider: 'huggingface' });
      }
    } catch (e) { console.error('HuggingFace failed:', e.message); }
  }

  return send(res, 503, { error: 'All image providers failed. Check your API keys and credits in the admin console.' });
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
  if (urlPath === '/api/stella-config') { cors(res); return send(res, 200, { assistant: DB.stellaAssistant || 'sonar' }); }
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

  // Web proxy for Stellar browser — fetches pages server-side to bypass iframe restrictions
  if (urlPath === '/proxy' && req.method === 'GET') {
    const qs = req.url.split('?')[1] || '';
    const params = new URLSearchParams(qs);
    const targetUrl = params.get('url');
    if (!targetUrl) return send(res, 400, { error: 'Missing url parameter' });
    
    try {
      const targetParsed = new URL(targetUrl);
      // Block localhost/internal requests for security
      if (['localhost', '127.0.0.1', '0.0.0.0'].includes(targetParsed.hostname)) {
        return send(res, 403, { error: 'Cannot proxy localhost' });
      }
      
      const upstream = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity'
        },
        redirect: 'follow'
      });
      
      const contentType = upstream.headers.get('content-type') || 'text/html';
      
      // For HTML pages, rewrite relative URLs and inject base tag
      if (contentType.includes('text/html')) {
        let html = await upstream.text();
        const base = targetParsed.origin;
        
        // Inject <base> tag so relative URLs resolve correctly
        if (/<head[^>]*>/i.test(html)) {
          html = html.replace(/<head[^>]*>/i, '$&<base href="' + base + '/">');
        } else {
          html = '<base href="' + base + '/">' + html;
        }
        
        // Rewrite links to go through proxy
        html = html.replace(/(href|src|action)=["']\/(?!\/)/gi, '$1="' + base + '/');
        
        // Inject script to intercept navigation and route through proxy
        const proxyScript = `<script>
        document.addEventListener('click', function(e) {
          var a = e.target.closest('a');
          if (a && a.href && !a.href.startsWith('javascript:')) {
            e.preventDefault();
            var url = a.href;
            if (url.startsWith('/proxy?')) return;
            window.parent.postMessage({ type: 'stellar-navigate', url: url }, '*');
          }
        }, true);
        document.addEventListener('submit', function(e) {
          var form = e.target;
          if (form.tagName === 'FORM' && form.action) {
            e.preventDefault();
            var fd = new FormData(form);
            var qs = new URLSearchParams(fd).toString();
            var url = form.action + (form.method.toLowerCase() === 'get' ? '?' + qs : '');
            window.parent.postMessage({ type: 'stellar-navigate', url: url }, '*');
          }
        }, true);
        </script>`;
        html = html.replace(/<\/body>/i, proxyScript + '</body>');
        
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'access-control-allow-origin': '*'
        });
        return res.end(html);
      }
      
      // For non-HTML (images, CSS, JS, etc.), pipe through directly
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'content-type': contentType,
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=3600'
      });
      return res.end(buf);
      
    } catch (e) {
      return send(res, 502, { error: 'Proxy error: ' + e.message });
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
:root{--bg:#0B0D10;--surface:#111418;--s2:#161A1F;--s3:#1E232A;--border:#242A31;--text:#EDEFF2;--muted:#6C7480;--brand:#B8E547;--ok:#7CE7A0;--danger:#F26D5B;--r:12px}
*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);font-size:14px}
button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}a{color:var(--brand)}
.login{min-height:100dvh;display:grid;place-items:center;padding:20px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:22px}
.login .card{width:min(380px,100%)}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.02em}
.mark{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#B8E547,#7CE7D8);display:inline-block;vertical-align:-6px;margin-right:8px}
.muted{color:var(--muted);font-size:13px}
input,select,textarea{width:100%;padding:10px 12px;background:var(--s2);border:1px solid var(--border);border-radius:8px;margin-top:6px}
textarea{min-height:70px;resize:vertical;font-family:ui-monospace,monospace;font-size:12.5px}
.btn{background:var(--s2);border:1px solid var(--border);border-radius:999px;padding:8px 16px;font-weight:600}
.btn:hover{border-color:var(--brand)}
.btn.grad{background:linear-gradient(135deg,#B8E547,#7CE7D8);color:#111;border:0}
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
.err{color:var(--danger);font-size:13px;margin-top:8px;min-height:18px}
@media(max-width:600px){.stats{grid-template-columns:1fr 1fr}}
</style></head><body>

<div class="login" id="login">
  <div class="card">
    <h1><span class="mark"></span>Mist Admin</h1>
    <p class="muted">Enter your admin password to continue.</p>
    <input id="pw" type="password" placeholder="Password" autocomplete="current-password">
    <button class="btn grad" style="width:100%;margin-top:12px" id="btnLogin">Unlock</button>
    <p class="err" id="loginErr"></p>
  </div>
</div>

<div id="app" style="display:none">
  <div class="top">
    <h1 style="font-size:17px"><span class="mark"></span>Mist Admin</h1>
    <span class="sp"></span>
    <button class="btn sm" id="btnRefresh">Refresh</button>
    <button class="btn sm" id="btnLogout">Log out</button>
  </div>
  <div class="wrap">
    <div class="stats" id="stats"></div>
    <div class="tabs" id="tabsBar"></div>
    <div class="pane on" id="pane-keys"></div>
    <div class="pane" id="pane-users"></div>
    <div class="pane" id="pane-chats"></div>
    <div class="pane" id="pane-projects"></div>
    <div class="pane" id="pane-settings"></div>
  </div>
</div>

<dialog id="dlg"><div class="dlg-h"><b id="dlgTitle">Chat</b><button class="btn sm" id="dlgClose">Close</button></div><div class="dlg-b" id="dlgBody"></div></dialog>
<div id="toast"></div>

<script>
var STATE = null;
var $ = function(s){return document.querySelector(s);};
var $$ = function(s){return Array.from(document.querySelectorAll(s));};
var esc = function(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});};
function toast(m){var t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(toast.t);toast.t=setTimeout(function(){t.classList.remove('on');},1800);}

function api(path,body){
  var opts = body ? {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)} : {};
  return fetch('/admin'+path, opts).then(function(r){
    if(r.status===401){show('login');throw new Error('auth');}
    return r.json();
  });
}
function show(which){$('#login').style.display=which==='login'?'grid':'none';$('#app').style.display=which==='app'?'block':'none';}

/* ---- login ---- */
$('#btnLogin').onclick = function(){
  var pw = $('#pw').value;
  fetch('/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw})})
    .then(function(r){
      if(r.ok){ $('#loginErr').textContent=''; show('app'); loadState(); }
      else { $('#loginErr').textContent = 'Wrong password. Try again.'; $('#pw').value=''; $('#pw').focus(); }
    })
    .catch(function(){ $('#loginErr').textContent = 'Could not reach the server.'; });
};
$('#pw').addEventListener('keydown',function(e){if(e.key==='Enter')$('#btnLogin').click();});
$('#btnRefresh').onclick = function(){loadState();};
$('#btnLogout').onclick = function(){fetch('/admin/logout').then(function(){show('login');});};
$('#dlgClose').onclick = function(){$('#dlg').close();};

/* ---- tabs ---- */
var TABS = [['keys','Keys & Models'],['users','Users'],['chats','Chats'],['projects','Projects'],['settings','Settings']];
function renderTabs(){
  $('#tabsBar').innerHTML = TABS.map(function(t){return '<button class="tab'+(t[0]==='keys'?' on':'')+'" data-tab="'+t[0]+'">'+t[1]+'</button>';}).join('');
}
renderTabs();
$('#tabsBar').addEventListener('click',function(e){
  var btn=e.target.closest('[data-tab]'); if(!btn)return;
  $$('.tab').forEach(function(x){x.classList.toggle('on',x===btn);});
  $$('.pane').forEach(function(p){p.classList.toggle('on',p.id==='pane-'+btn.dataset.tab);});
});

/* ---- load state ---- */
function loadState(){
  return api('/state').then(function(d){
    STATE=d;
    var s=d.stats;
    $('#stats').innerHTML=stat(s.users,'Users')+stat(s.chats,'Chats')+stat(s.projects,'Projects')+stat(s.banned,'Banned');
    renderKeys();renderUsers();renderChats();renderProjects();renderSettings();
  });
}
function stat(n,l){return '<div class="stat"><b>'+n+'</b><span>'+l+'</span></div>';}

/* ---- keys & models ---- */
function provOpts(sel){
  return Object.keys(STATE.providers).map(function(id){
    var p=STATE.providers[id];
    return '<option value="'+id+'"'+(id===sel?' selected':'')+'>'+esc(p.label)+'</option>';
  }).join('');
}

function modelOpts(providerId, sel){
  var p=STATE.providers[providerId];
  if(!p || !p.models || !Array.isArray(p.models)) return '';
  return p.models.map(function(m){
    return '<option value="'+esc(m)+'"'+(m===sel?' selected':'')+'>'+esc(m)+'</option>';
  }).join('');
}

function chainRows(chainId, chain){
  return (chain||[]).map(function(f,i){
    var p=STATE.providers[f.provider];
    var modelInput = (p && p.models && Array.isArray(p.models))
      ? '<select id="'+chainId+'-m-'+i+'">'+modelOpts(f.provider, f.model)+'</select>'
      : '<input id="'+chainId+'-m-'+i+'" value="'+esc(f.model||'')+'" placeholder="model id">';
    return '<div class="row" style="margin-top:6px;align-items:center">'
      +'<div><select id="'+chainId+'-p-'+i+'">'+provOpts(f.provider)+'</select></div>'
      +'<div>'+modelInput+'</div>'
      +'<button class="btn sm danger" style="flex:none" data-rm-row="'+chainId+'" data-idx="'+i+'">x</button></div>';
  }).join('');
}
function collectChain(chainId){
  var out=[],i=0;
  while(document.getElementById(chainId+'-p-'+i)){
    var m=document.getElementById(chainId+'-m-'+i).value.trim();
    if(m) out.push({provider:document.getElementById(chainId+'-p-'+i).value,model:m});
    i++;
  }
  return out;
}

function renderKeys(){
  var P=STATE.providers, R=STATE.routing, SP=STATE.systemPrompts||{};

  /* Helper: list of providers that have a key */
  var keyed = Object.keys(P).filter(function(id){return P[id].hasKey;});
  var keyedOpts = function(sel){
    return keyed.map(function(id){return '<option value="'+id+'"'+(id===sel?' selected':'')+'>'+esc(P[id].label)+'</option>';}).join('');
  };

  var html = '';

  /* ---- Step 1: Your API Keys ---- */
  html+='<div class="card"><h3 style="margin-top:0">Step 1: Your API keys</h3>'
    +'<p class="muted">Paste keys from the AI providers you have accounts with. You can add up to 2 keys per provider. Only providers with keys can power the Mist AIs below.</p>';
  Object.keys(P).forEach(function(id){
    var p=P[id];
    html+='<div class="prov" style="padding:10px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">'
      +'<b style="min-width:150px">'+esc(p.label)+'</b> '
      +(p.hasKey?'<span class="badge ok">'+(p.fromEnv?'env var':'key set')+' '+esc(p.keyMask)+'</span>':'<span class="badge no">no key</span>')
      +' <input type="password" id="pk-'+id+'" placeholder="'+(p.hasKey?'replace key':'paste key here')+'" style="flex:1;min-width:140px;margin:0">'
      +' <button class="btn sm grad" data-save-prov="'+id+'">Save</button></div>';
  });
  html+='</div>';

  /* ---- Step 2: Pick models for each AI ---- */
  html+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:14px">';

  /* Pluto card */
  var r1 = R.pluto || {};
  var p1 = STATE.providers[r1.provider];
  var m1ModelInput = (p1 && p1.models && Array.isArray(p1.models))
    ? '<select id="m1-m">'+modelOpts(r1.provider, r1.model)+'</select>'
    : '<input id="m1-m" value="'+esc(r1.model||'')+'" placeholder="e.g. gemini-2.0-flash">';
  html+='<div class="card" style="border-left:3px solid var(--brand)">'
    +'<h3 style="margin:0 0 4px">Pluto</h3>'
    +'<p class="muted" style="margin:0 0 12px">Quick everyday assistant. Responds fast.</p>'
    +'<label style="font-weight:600;font-size:12px">Provider</label>'
    +'<select id="m1-p" style="margin-bottom:8px">'+provOpts(r1.provider)+'</select>'
    +'<label style="font-weight:600;font-size:12px">Model ID</label>'
    +m1ModelInput
    +'<button class="btn grad" style="width:100%;margin-top:12px" id="saveM1">Save Pluto</button></div>';

  /* Sonar card */
  var r2 = R.sonar || {};
  html+='<div class="card" style="border-left:3px solid #F26D5B">'
    +'<h3 style="margin:0 0 4px">Sonar</h3>'
    +'<p class="muted" style="margin:0 0 12px">Engineering powerhouse. Best code possible.</p>'
    +'<p class="muted" style="font-size:11.5px;margin:0 0 8px"><b>Coding chain</b> — for text/code (up to 6 models, tried in order):</p>'
    +'<div id="m2c-rows">'+chainRows('m2c',r2.codingChain)+'</div><button class="btn sm" data-add-row="m2c" style="margin:4px 0 10px">+ Add model</button>'
    +'<p class="muted" style="font-size:11.5px;margin:0 0 8px"><b>Multimodal chain</b> — when user sends images/videos/links:</p>'
    +'<div id="m2m-rows">'+chainRows('m2m',r2.multimodalChain)+'</div><button class="btn sm" data-add-row="m2m" style="margin:4px 0">+ Add model</button>'
    +'<button class="btn grad" style="width:100%;margin-top:12px" id="saveM2">Save Sonar</button></div>';

  /* Omni card */
  var r3 = R.omni || {};
  var p3 = STATE.providers[r3.provider];
  var m3ModelInput = (p3 && p3.models && Array.isArray(p3.models))
    ? '<select id="m3-m">'+modelOpts(r3.provider, r3.model)+'</select>'
    : '<input id="m3-m" value="'+esc(r3.model||'')+'" placeholder="e.g. gemini-2.0-flash" style="margin-bottom:10px">';
  html+='<div class="card" style="border-left:3px solid #8B5CF6">'
    +'<h3 style="margin:0 0 4px">Omni</h3>'
    +'<p class="muted" style="margin:0 0 12px">Visual creative. Images, video, critique.</p>'
    +'<label style="font-weight:600;font-size:12px">Chat model (crafts prompts)</label>'
    +'<select id="m3-p" style="margin-bottom:4px">'+provOpts(r3.provider)+'</select>'
    +m3ModelInput
    +'<label style="font-weight:600;font-size:12px">Image provider (Stability, Replicate, Fal.ai, or HuggingFace key above)</label>'
    +'<p class="muted" style="font-size:11.5px;margin:2px 0 0">'+(P.stability && P.stability.hasKey ? '<span class="badge ok">Stability ready</span>' : P.replicate && P.replicate.hasKey ? '<span class="badge ok">Replicate ready</span>' : P.fal && P.fal.hasKey ? '<span class="badge ok">Fal.ai ready</span>' : P.huggingface && P.huggingface.hasKey ? '<span class="badge ok">HuggingFace ready</span>' : '<span class="badge no">Add a Stability, Replicate, Fal.ai, or HuggingFace key above</span>')+'</p>'
    +'<button class="btn grad" style="width:100%;margin-top:12px" id="saveM3">Save Omni</button></div>';
  html+='</div>';

  /* ---- Stella ---- */
  var sa = STATE.stellaAssistant || 'sonar';
  html+='<div class="card" style="margin-top:14px"><h3 style="margin-top:0">Stella (Stellar browser AI)</h3>'
    +'<p class="muted">Which Mist AI powers Stella. She uses whatever model that AI is set to.</p>'
    +'<select id="stella-a"><option value="pluto"'+(sa==='pluto'?' selected':'')+'>Pluto</option><option value="sonar"'+(sa==='sonar'?' selected':'')+'>Sonar</option><option value="omni"'+(sa==='omni'?' selected':'')+'>Omni</option></select>'
    +'<button class="btn grad" style="margin-top:10px" id="saveStella">Save Stella</button></div>';

  /* ---- Shared Google ---- */
  html+='<div class="card" style="margin-top:14px"><h3 style="margin-top:0">Shared Google account</h3>'
    +'<p class="muted">Link one Google account. All Mist AIs can read Gmail and Calendar from it.</p>'
    +'<div id="google-status"><em class="muted">Loading...</em></div>'
    +'<div id="google-actions" style="margin-top:8px"></div></div>';

  /* ---- System prompts ---- */
  html+='<div class="card" style="margin-top:14px"><h3 style="margin-top:0">Custom personalities (optional)</h3>'
    +'<p class="muted">Override the built-in personality. Leave blank = use defaults (recommended).</p>'
    +'<details><summary style="cursor:pointer;font-weight:600;font-size:13px;color:var(--muted)">Show prompt editors</summary>'
    +'<h4 style="margin:12px 0 6px">Pluto</h4><textarea id="sp-pluto">'+esc(SP.pluto||'')+'</textarea>'
    +'<div style="display:flex;gap:8px;margin-top:6px"><button class="btn sm grad" data-save-sp="pluto">Save</button><button class="btn sm danger" data-clear-sp="pluto">Reset</button></div>'
    +'<h4 style="margin:12px 0 6px">Sonar</h4><textarea id="sp-sonar">'+esc(SP.sonar||'')+'</textarea>'
    +'<div style="display:flex;gap:8px;margin-top:6px"><button class="btn sm grad" data-save-sp="sonar">Save</button><button class="btn sm danger" data-clear-sp="sonar">Reset</button></div>'
    +'<h4 style="margin:12px 0 6px">Omni</h4><textarea id="sp-omni">'+esc(SP.omni||'')+'</textarea>'
    +'<div style="display:flex;gap:8px;margin-top:6px"><button class="btn sm grad" data-save-sp="omni">Save</button><button class="btn sm danger" data-clear-sp="omni">Reset</button></div>'
    +'</details></div>';

  $('#pane-keys').innerHTML=html;
  refreshGoogle();
}

function refreshGoogle(){
  var s=$('#google-status'),a=$('#google-actions'); if(!s)return;
  fetch('/admin/google/status').then(function(r){return r.json();}).then(function(d){
    if(d.linked){s.innerHTML='<span class="badge ok">Linked</span> <b>'+esc(d.email)+'</b>';a.innerHTML='<button class="btn sm danger" id="unlinkGoogle">Unlink</button>';}
    else{s.innerHTML='<span class="badge no">Not linked</span>';
      fetch('/admin/google/link-url').then(function(r){return r.json();}).then(function(u){
        a.innerHTML=u.url?'<a class="btn sm grad" href="'+u.url+'">Link Google</a>':'<span class="muted" style="font-size:12px">Set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET env vars first.</span>';
      });
    }
  }).catch(function(){s.innerHTML='<em class="muted">Unavailable</em>';});
}

/* ---- users ---- */
function renderUsers(){
  var rows=STATE.users.map(function(u){
    return '<tr><td>'+esc(u.id)+'</td><td>'+new Date(u.firstSeen).toLocaleDateString()+'</td>'
      +'<td>'+new Date(u.lastSeen).toLocaleString()+'</td><td>'+u.messages+'</td>'
      +'<td>'+(u.banned?'<span class="badge ban">Banned</span>':'<span class="badge ok">Active</span>')+'</td>'
      +'<td style="text-align:right"><button class="btn sm" data-ban="'+esc(u.id)+'" data-val="'+(!u.banned)+'">'+(u.banned?'Unban':'Ban')+'</button> '
      +'<button class="btn sm danger" data-del-user="'+esc(u.id)+'">Delete</button></td></tr>';
  }).join('');
  $('#pane-users').innerHTML='<div class="card"><h3 style="margin-top:0">Users</h3>'
    +'<table><thead><tr><th>User</th><th>First</th><th>Last</th><th>Msgs</th><th>Status</th><th></th></tr></thead><tbody>'
    +(rows||'<tr><td colspan=6 class=muted>No users yet.</td></tr>')+'</tbody></table></div>';
}

/* ---- chats ---- */
function renderChats(){
  var rows=STATE.chats.map(function(c){
    return '<tr><td>'+esc(c.title||'Untitled')+'</td><td>'+esc(c.assistant||'')+'</td>'
      +'<td>'+esc((c.userId||'').slice(0,12))+'</td><td>'+((c.messages&&c.messages.length)||0)+'</td>'
      +'<td>'+(c.updatedAt?new Date(c.updatedAt).toLocaleString():'')+'</td>'
      +'<td style="text-align:right"><button class="btn sm" data-view-chat="'+c.id+'">View</button> '
      +'<button class="btn sm danger" data-del-chat="'+c.id+'">Delete</button></td></tr>';
  }).join('');
  $('#pane-chats').innerHTML='<div class="card"><h3 style="margin-top:0">Chats</h3>'
    +'<table><thead><tr><th>Title</th><th>Model</th><th>User</th><th>Msgs</th><th>Updated</th><th></th></tr></thead><tbody>'
    +(rows||'<tr><td colspan=6 class=muted>No chats yet.</td></tr>')+'</tbody></table></div>';
}

/* ---- projects ---- */
function renderProjects(){
  var rows=STATE.projects.map(function(p){
    return '<tr><td>'+esc(p.name)+'</td><td>'+esc((p.userId||'').slice(0,12))+'</td>'
      +'<td>'+esc((p.instructions||'').slice(0,80))+'</td>'
      +'<td style="text-align:right"><button class="btn sm danger" data-del-proj="'+p.id+'">Delete</button></td></tr>';
  }).join('');
  $('#pane-projects').innerHTML='<div class="card"><h3 style="margin-top:0">Projects</h3>'
    +'<table><thead><tr><th>Name</th><th>User</th><th>Instructions</th><th></th></tr></thead><tbody>'
    +(rows||'<tr><td colspan=4 class=muted>No projects.</td></tr>')+'</tbody></table></div>';
}

/* ---- settings ---- */
function renderSettings(){
  $('#pane-settings').innerHTML='<div class="card"><h3 style="margin-top:0">Change admin password</h3>'
    +'<input type="password" id="newpw" placeholder="At least 4 characters">'
    +'<button class="btn grad" style="margin-top:10px" id="changePw">Update password</button></div>'
    +'<div class="card" style="margin-top:14px"><h3 style="margin-top:0">Server endpoint</h3>'
    +'<pre>'+location.origin+'/api/chat</pre></div>';
}

/* ---- all event delegation ---- */
document.addEventListener('click',function(e){
  var t=e.target,el;
  /* providers — simplified: only key field exists in new layout */
  el=t.closest('[data-save-prov]');if(el){var id=el.dataset.saveProv;var key=$('#pk-'+id).value;api('/provider',{id:id,apiKey:key}).then(function(){toast('Key saved');loadState();});return;}
  el=t.closest('[data-del-prov]');if(el){if(confirm('Remove?'))api('/provider/delete',{id:el.dataset.delProv}).then(function(){loadState();});return;}
  if(t.id==='addProvBtn'){var id=prompt('Provider id (e.g. groq, together)');if(id)api('/provider',{id:id.trim(),label:id,format:'openai',baseUrl:'',apiKey:''}).then(function(){loadState();});return;}
  /* mist 1 routing */
  if(t.id==='saveM1'){api('/routing',{routing:{pluto:{provider:$('#m1-p').value,model:$('#m1-m').value.trim(),fallbacks:[]}}}).then(function(){toast('Pluto saved');loadState();});return;}
  /* sonar routing */
  if(t.id==='saveM2'){api('/routing',{routing:{sonar:{codingChain:collectChain('m2c'),multimodalChain:collectChain('m2m'),fallbacks:collectChain('m2f')}}}).then(function(){toast('Sonar saved');loadState();});return;}
  /* omni routing */
  if(t.id==='saveM3'){api('/routing',{routing:{omni:{provider:$('#m3-p').value,model:$('#m3-m').value.trim(),fallbacks:[]}}}).then(function(){toast('Omni saved');loadState();});return;}
  /* chain add/remove */
  el=t.closest('[data-add-row]');if(el){var cid=el.dataset.addRow,rows=document.getElementById(cid+'-rows'),i=rows.querySelectorAll('.row').length;if(i>=6){toast('Max 6');return;}var defProv=Object.keys(STATE.providers)[0],p=STATE.providers[defProv],modelInput=(p&&p.models&&Array.isArray(p.models))?'<select id="'+cid+'-m-'+i+'">'+modelOpts(defProv,'')+'</select>':'<input id="'+cid+'-m-'+i+'" placeholder="model id">';var d=document.createElement('div');d.className='row';d.style.marginTop='6px';d.style.alignItems='center';d.innerHTML='<div><select id="'+cid+'-p-'+i+'">'+provOpts(defProv)+'</select></div><div>'+modelInput+'</div><button class="btn sm danger" style="flex:none" data-rm-row="'+cid+'" data-idx="'+i+'">x</button>';rows.appendChild(d);return;}
  el=t.closest('[data-rm-row]');if(el){el.closest('.row').remove();return;}
  /* stella */
  if(t.id==='saveStella'){api('/stella',{assistant:$('#stella-a').value}).then(function(){toast('Stella saved');loadState();});return;}
  /* google */
  if(t.id==='unlinkGoogle'){if(confirm('Unlink?'))fetch('/admin/google/unlink',{method:'POST'}).then(function(){refreshGoogle();});return;}
  /* system prompts */
  el=t.closest('[data-save-sp]');if(el){var a=el.dataset.saveSp;api('/systemprompt',{assistant:a,prompt:$('#sp-'+a).value}).then(function(){toast('Prompt saved');});return;}
  el=t.closest('[data-clear-sp]');if(el){if(!confirm('Reset to default?'))return;var a=el.dataset.clearSp;$('#sp-'+a).value='';api('/systemprompt',{assistant:a,prompt:''}).then(function(){toast('Reset');});return;}
  /* users */
  el=t.closest('[data-ban]');if(el){api('/ban',{userId:el.dataset.ban,banned:el.dataset.val==='true'}).then(function(){toast('Done');loadState();});return;}
  el=t.closest('[data-del-user]');if(el){if(confirm('Delete user?'))api('/user/delete',{userId:el.dataset.delUser}).then(function(){loadState();});return;}
  /* chats */
  el=t.closest('[data-view-chat]');if(el){api('/chat/get',{id:el.dataset.viewChat}).then(function(c){$('#dlgTitle').textContent=c.title||'Chat';$('#dlgBody').innerHTML=(c.messages||[]).map(function(m){return '<div style="margin-bottom:12px"><b style="color:var(--brand)">'+esc(m.role)+'</b><pre>'+esc(m.content)+'</pre></div>';}).join('')||'<p class=muted>Empty</p>';$('#dlg').showModal();});return;}
  el=t.closest('[data-del-chat]');if(el){if(confirm('Delete chat?'))api('/chat/delete',{id:el.dataset.delChat}).then(function(){loadState();});return;}
  /* projects */
  el=t.closest('[data-del-proj]');if(el){if(confirm('Delete project?'))api('/project/delete',{id:el.dataset.delProj}).then(function(){loadState();});return;}
  /* settings */
  if(t.id==='changePw'){var pw=$('#newpw').value;if(pw.length<4){toast('Too short');return;}api('/password',{password:pw}).then(function(){toast('Password updated');$('#newpw').value='';});return;}
});

/* boot */
(function(){try{loadState().then(function(){show('app');}).catch(function(){show('login');});}catch(e){show('login');}})();
</script>
</body></html>`;
