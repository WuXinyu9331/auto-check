#!/usr/bin/env node
'use strict';

/**
 * my-aime.cn / JINALE 每日签到
 * ---------------------------------------------------------------
 * 站内"每日奖励"按钮点击时实际做的事就是：
 *   1. POST https://api.jinale.com/web/login           （登录拿 token）
 *   2. POST https://api.jinale.com/web/dailyBonus      （查询今天能不能领）
 *   3. POST https://api.jinale.com/web/dailyBonus/receive（领取 = 签到）
 *
 * 本脚本直接调用同样三个接口，等价于"打开网页 → 登录 → 点签到按钮"，
 * 但不需要浏览器，跑一次只要几秒钟，在 GitHub Actions 上非常稳。
 *
 * 只用 Node 18+ 自带的 fetch / crypto，没有任何第三方依赖。
 * ---------------------------------------------------------------
 * 环境变量：
 *   JINALE_USERNAME  必填，账号
 *   JINALE_PASSWORD  必填，密码（明文，脚本内部按站点规则加密后再发送）
 *   FORCE            1/true = 忽略随机时间，立即签到（手动触发时用）
 *   WINDOW_START     随机时间段起点，默认 08:00（北京时间）
 *   WINDOW_END       随机时间段终点，默认 11:30（北京时间）
 *   DRY_RUN          1/true = 只登录查询，不真的领奖
 */

const crypto = require('crypto');

// ============================ 站点常量 ============================
const API_BASE = 'https://api.jinale.com';
const SITE_ORIGIN = 'https://my-aime.cn';
const SITE_REFERER = 'https://my-aime.cn/hellowhen/';
// 站点前端对密码做的处理：HMAC-SHA1(key = SECRET, msg = 明文密码) 的十六进制小写
const PASSWORD_HMAC_KEY = '3012efd1056e7b8bf0f19a79814e906ab0afc81c';
const TZ_OFFSET_MINUTES = 8 * 60; // 全部按北京时间（UTC+8）计算

// ============================ 配置读取 ============================
function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === null || String(v).trim() === '' ? fallback : String(v).trim();
}
function flag(name) {
  return /^(1|true|yes|on)$/i.test(env(name));
}

const USERNAME = env('JINALE_USERNAME');
const PASSWORD = env('JINALE_PASSWORD');
const FORCE = flag('FORCE');
const DRY_RUN = flag('DRY_RUN');
const WINDOW_START = env('WINDOW_START', '08:00');
const WINDOW_END = env('WINDOW_END', '11:30');

// ============================ 小工具 ============================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`时间格式应为 HH:MM，收到：${hhmm}`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new Error(`时间超出范围：${hhmm}`);
  return h * 60 + mi;
}
function fmtMinutes(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
/** 当前"北京时间"（用 UTC 取值即为北京墙上时间） */
function beijingNow() {
  return new Date(Date.now() + TZ_OFFSET_MINUTES * 60 * 1000);
}
function beijingDateStr(d = beijingNow()) {
  return d.toISOString().slice(0, 10);
}
function beijingMinuteOfDay(d = beijingNow()) {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * 用当天日期做种子，算出"今天上午的随机签到时刻"。
 * 同一天算出来永远一样（可复现、可排查），不同天各不相同。
 */
function pickTargetMinute(dateStr) {
  const start = toMinutes(WINDOW_START);
  const end = toMinutes(WINDOW_END);
  const span = end - start + 1;
  if (span <= 0) throw new Error(`WINDOW_END(${WINDOW_END}) 必须晚于 WINDOW_START(${WINDOW_START})`);
  const digest = crypto.createHash('sha256').update(`jinale-daily-checkin:${dateStr}`).digest();
  return start + (digest.readUInt32BE(0) % span);
}

/** 站点前端使用的密码摘要 */
function hashPassword(plain) {
  return crypto.createHmac('sha1', PASSWORD_HMAC_KEY).update(plain, 'utf8').digest('hex').toLowerCase();
}

// ============================ HTTP ============================
const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
  'Accept-Language': 'zh-CN',
  Accept: 'application/json, text/plain, */*',
  Origin: SITE_ORIGIN,
  Referer: SITE_REFERER,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

async function api(path, body, token) {
  const url = API_BASE + path;
  let lastErr = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const headers = { ...BASE_HEADERS };
      if (token) headers.Authorization = token;

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body || {}),
      });
      const text = await res.text();

      let json;
      try {
        json = JSON.parse(text);
      } catch (_) {
        throw new Error(`${path} 返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
      }
      return { status: res.status, json, authHeader: res.headers.get('authorization') };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        const wait = attempt * 3000;
        console.log(`   ！${path} 第 ${attempt} 次请求失败：${err.message}，${wait / 1000}s 后重试`);
        await sleep(wait);
      }
    }
  }
  throw new Error(`${path} 连续 3 次请求失败：${lastErr && lastErr.message}`);
}

// ============================ 主流程 ============================
function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

async function main() {
  console.log('======== my-aime.cn 每日签到 ========');
  const now = beijingNow();
  const dateStr = beijingDateStr(now);
  const nowMin = beijingMinuteOfDay(now);
  const targetMin = pickTargetMinute(dateStr);

  console.log(`北京时间：${dateStr} ${fmtMinutes(nowMin)}`);
  console.log(`今日随机签到时刻：${fmtMinutes(targetMin)}（窗口 ${WINDOW_START} ~ ${WINDOW_END}）`);

  // 1) 随机时间判断：没到点就直接下班，等下一次定时任务
  if (!FORCE && nowMin < targetMin) {
    console.log(`\n⏳ 还没到今天的随机时间（${fmtMinutes(targetMin)}），本次跳过，稍后自动重试。`);
    return 0;
  }
  if (FORCE) console.log('（FORCE 已开启，忽略随机时间判断）');

  if (!USERNAME || !PASSWORD) {
    fail(
      '缺少账号或密码。请设置环境变量 JINALE_USERNAME 和 JINALE_PASSWORD；\n' +
        '   在 GitHub 上就是 Settings → Secrets and variables → Actions → New repository secret。'
    );
  }
  console.log(`账号：${USERNAME.replace(/^(.).*(.)$/, '$1***$2')}`);

  // 2) 登录
  const login = await api('/web/login', {
    username: USERNAME,
    password: hashPassword(PASSWORD),
    turnstile_token: '',
  });
  if (!login.json || login.json.code <= 0) {
    fail(`登录失败：${(login.json && login.json.msg) || '未知错误'}（code=${login.json && login.json.code}）`);
  }
  const token = login.authHeader || (login.json.data && login.json.data.token);
  if (!token) fail('登录成功但没有拿到 token，站点接口可能变了。');
  const displayName = (login.json.data && login.json.data.username) || USERNAME;
  console.log(`✅ 登录成功：${displayName}`);

  // 3) 查询今天是否还能领
  const info = await api('/web/dailyBonus', {}, token);
  if (!info.json || info.json.code <= 0) {
    fail(`查询签到状态失败：${(info.json && info.json.msg) || '未知错误'}`);
  }
  const canReceive = info.json.data === true;

  if (!canReceive) {
    console.log('\n🎉 今天已经签到过了，无需重复操作。');
    return 0;
  }

  if (DRY_RUN) {
    console.log('\n🧪 DRY_RUN 模式：今天可以签到，但按要求没有真的领取。');
    return 0;
  }

  // 4) 签到（= 点"每日奖励"按钮）
  const recv = await api('/web/dailyBonus/receive', {}, token);
  const code = recv.json ? recv.json.code : -999;
  const msg = (recv.json && recv.json.msg) || '';

  if (code > 0) {
    console.log(`\n✅ 签到成功！服务器返回：${msg || '领取成功'}`);
    return 0;
  }
  if (/已领取|已经领取|已签到/.test(msg)) {
    console.log(`\n🎉 今天已经签到过了（${msg}）。`);
    return 0;
  }
  fail(`签到失败：${msg || '未知错误'}（code=${code}）`);
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error(`\n❌ 执行出错：${err && err.message ? err.message : err}`);
    process.exit(1);
  });
