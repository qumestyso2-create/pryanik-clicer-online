import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const required = ['TELEGRAM_BOT_TOKEN','APP_JWT_SECRET','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing env var: ${key}`);
if (process.env.APP_JWT_SECRET.length < 32) throw new Error('APP_JWT_SECRET must be at least 32 characters');

const app = express();
const port = Number(process.env.PORT || 4000);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

app.use(cors({ origin: process.env.CLIENT_ORIGIN?.split(',') || 'http://localhost:5173' }));
app.use(express.json({ limit: '32kb' }));

function issueToken(user) {
  return jwt.sign({ sub: String(user.id), telegram_id: String(user.telegram_id), username: user.username || null },
    process.env.APP_JWT_SECRET, { expiresIn: '14d', issuer: 'pryanik-clicker' });
}
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try {
    if (!token) throw new Error('missing');
    req.user = jwt.verify(token, process.env.APP_JWT_SECRET, { issuer: 'pryanik-clicker' });
    next();
  } catch { res.status(401).json({ error: 'Требуется авторизация через Telegram' }); }
}

function adminOnly(req, res, next) {
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || '');
  if (!adminId || String(req.user?.telegram_id) !== adminId) return res.status(403).json({ error:'Доступ только для администратора' });
  next();
}

function verifyTelegramWebApp(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('Missing Telegram hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(calculated, 'hex'), Buffer.from(hash, 'hex'))) throw new Error('Invalid Telegram signature');
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now()/1000 - authDate > 86400 || authDate > Date.now()/1000 + 60) throw new Error('Expired Telegram auth');
  const user = JSON.parse(params.get('user') || '{}');
  if (!user.id) throw new Error('Missing Telegram user');
  return user;
}
function verifyTelegramWidget(data) {
  const { hash, ...fields } = data || {};
  if (!hash || typeof hash !== 'string') throw new Error('Missing Telegram hash');
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (!/^[a-f0-9]{64}$/i.test(hash) || !crypto.timingSafeEqual(Buffer.from(calculated,'hex'), Buffer.from(hash,'hex'))) throw new Error('Invalid Telegram signature');
  const authDate = Number(fields.auth_date);
  if (!authDate || Date.now()/1000 - authDate > 86400 || authDate > Date.now()/1000 + 60) throw new Error('Expired Telegram login');
  if (!fields.id) throw new Error('Missing Telegram user');
  return { id: fields.id, first_name: fields.first_name, last_name: fields.last_name, username: fields.username, photo_url: fields.photo_url };
}
async function upsertTelegramUser(tg) {
  const payload = {
    telegram_id: String(tg.id),
    username: tg.username || null,
    first_name: tg.first_name || 'Игрок',
    last_name: tg.last_name || null,
    photo_url: tg.photo_url || null,
    updated_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from('players').upsert(payload, { onConflict: 'telegram_id' }).select('id,telegram_id,username,first_name,photo_url').single();
  if (error) throw error;
  const { error: stateError } = await supabase.from('game_state').upsert({ player_id: data.id }, { onConflict: 'player_id', ignoreDuplicates: true });
  if (stateError) throw stateError;
  return data;
}

app.get('/api/health', (_req,res)=>res.json({ ok:true, name:'PRYANIK CLICKER API' }));
app.post('/api/auth/telegram-webapp', async (req,res) => {
  try {
    const tg = verifyTelegramWebApp(req.body?.initData || '');
    const user = await upsertTelegramUser(tg);
    res.json({ token: issueToken(user), user });
  } catch (e) { console.error('webapp auth:', e.message); res.status(401).json({ error:'Не удалось проверить Telegram авторизацию' }); }
});
app.post('/api/auth/telegram-widget', async (req,res) => {
  try {
    const tg = verifyTelegramWidget(req.body);
    const user = await upsertTelegramUser(tg);
    res.json({ token: issueToken(user), user });
  } catch (e) { console.error('widget auth:', e.message); res.status(401).json({ error:'Не удалось проверить Telegram авторизацию' }); }
});
app.get('/api/me', auth, async (req,res) => {
  // Collect passive income on the server; client cannot set its own balance.
  const { error: tickError } = await supabase.rpc('collect_passive_income', { p_player_id:req.user.sub });
  if (tickError) return res.status(500).json({ error:'Не удалось обновить доход' });
  const { data, error } = await supabase.from('game_state').select('*').eq('player_id', req.user.sub).single();
  if (error) return res.status(500).json({ error:'Не удалось загрузить профиль' });
  const clickCost = Math.floor(50 * Math.pow(1.55, data.click_level));
  const autoCost = Math.floor(150 * Math.pow(1.62, data.auto_level));
  const multiplierCost = Math.floor(1200 * Math.pow(2.15, data.multiplier_level));
  res.json({ state:{ ...data, click_upgrade_cost:clickCost, auto_upgrade_cost:autoCost, multiplier_upgrade_cost:multiplierCost } });
});
app.post('/api/game/click', auth, async (req,res) => {
  const { data, error } = await supabase.rpc('game_click', { p_player_id:req.user.sub });
  if (error) return res.status(400).json({ error:'Не удалось засчитать клик' });
  res.json({ state:data });
});
app.post('/api/game/upgrade', auth, async (req,res) => {
  const allowed = ['click_power','auto_income','multiplier'];
  const type = req.body?.type;
  if (!allowed.includes(type)) return res.status(400).json({ error:'Неизвестное улучшение' });
  const { data, error } = await supabase.rpc('buy_upgrade', { p_player_id:req.user.sub, p_type:type });
  if (error) return res.status(400).json({ error: error.message.includes('INSUFFICIENT') ? 'Недостаточно энергии' : 'Не удалось купить улучшение' });
  res.json({ state:data });
});
app.get('/api/leaderboard', auth, async (_req,res) => {
  const { data, error } = await supabase.from('leaderboard').select('telegram_id,username,first_name,balance,total_earned,level').order('total_earned',{ascending:false}).limit(100);
  if (error) return res.status(500).json({ error:'Не удалось загрузить рейтинг' });
  res.json({ players:data || [] });
});
app.post('/api/game/daily', auth, async (req,res) => {
  const { data, error } = await supabase.rpc('claim_daily_bonus', { p_player_id:req.user.sub });
  if (error) return res.status(400).json({ error: error.message.includes('COOLDOWN') ? 'Ежедневный бонус уже получен' : 'Не удалось получить бонус' });
  res.json({ state:data });
});
app.post('/api/promo/redeem', auth, async (req,res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return res.status(400).json({ error:'Проверь промокод' });
  const { data, error } = await supabase.rpc('redeem_promo', { p_player_id:req.user.sub, p_code:code });
  if (error) return res.status(400).json({ error: error.message.includes('ALREADY_USED') ? 'Ты уже активировал этот код' : 'Промокод недействителен или закончился' });
  res.json({ state:data });
});


// Предложения игроков разработчику
app.post('/api/suggestions', auth, async (req,res) => {
  const message = String(req.body?.message || '').trim();
  if (message.length < 5 || message.length > 1000) return res.status(400).json({ error:'Напиши от 5 до 1000 символов' });
  const { error } = await supabase.from('developer_suggestions').insert({ player_id:req.user.sub, message });
  if (error) return res.status(500).json({ error:'Не удалось отправить предложение' });
  res.json({ ok:true, message:'Предложение отправлено разработчику!' });
});

// Админские маршруты: кроме JWT проверяют числовой Telegram ID на сервере.
app.get('/api/admin/suggestions', auth, adminOnly, async (_req,res) => {
  const { data, error } = await supabase.from('developer_suggestions').select('id,message,created_at,player_id,players(username,first_name,telegram_id)').order('created_at',{ascending:false}).limit(100);
  if (error) return res.status(500).json({ error:'Не удалось загрузить предложения' });
  res.json({ suggestions:data || [] });
});
app.get('/api/admin/promos', auth, adminOnly, async (_req,res) => {
  const { data, error } = await supabase.from('promo_codes').select('code,reward,max_uses,uses,expires_at,enabled,created_at').order('created_at',{ascending:false}).limit(100);
  if (error) return res.status(500).json({ error:'Не удалось загрузить промокоды' });
  res.json({ promos:data || [] });
});
app.post('/api/admin/promos', auth, adminOnly, async (req,res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const reward = Number(req.body?.reward);
  const maxUses = req.body?.max_uses === '' || req.body?.max_uses == null ? null : Number(req.body.max_uses);
  const expiresAt = req.body?.expires_at || null;
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return res.status(400).json({ error:'Код: 3–32 символа A–Z, 0–9, _ или -' });
  if (!Number.isSafeInteger(reward) || reward < 1 || reward > 1000000000) return res.status(400).json({ error:'Проверь размер награды' });
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000000)) return res.status(400).json({ error:'Лимит должен быть положительным числом' });
  const { data, error } = await supabase.from('promo_codes').insert({ code,reward,max_uses:maxUses,expires_at:expiresAt }).select().single();
  if (error) return res.status(400).json({ error: error.code === '23505' ? 'Такой промокод уже существует' : 'Не удалось создать промокод' });
  res.json({ promo:data });
});
app.patch('/api/admin/promos/:code', auth, adminOnly, async (req,res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error:'Некорректное действие' });
  const { data, error } = await supabase.from('promo_codes').update({ enabled }).eq('code',String(req.params.code).toUpperCase()).select().single();
  if (error) return res.status(400).json({ error:'Не удалось изменить промокод' });
  res.json({ promo:data });
});

app.listen(port, ()=>console.log(`PRYANIK API listening on ${port}`));
