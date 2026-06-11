const express = require('express');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 데이터 폴더 (설정·수신자 목록 영구 저장)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const EMAILS_FILE = path.join(DATA_DIR, 'emails.json');

// Gmail 설정: 환경변수 우선, 없으면 로컬 파일(UI에서 저장)
function getGmailConfig() {
  if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
    return { gmailUser: process.env.GMAIL_USER, gmailPass: process.env.GMAIL_PASS, fromEnv: true };
  }
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return { ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')), fromEnv: false };
    } catch (e) {}
  }
  return { fromEnv: false };
}

function saveGmailConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// 이메일 목록: 환경변수(RECIPIENT_EMAILS) + 로컬 파일 합산
function loadEmails() {
  const envEmails = process.env.RECIPIENT_EMAILS
    ? process.env.RECIPIENT_EMAILS.split(',').map(e => e.trim()).filter(Boolean)
    : [];
  let fileEmails = [];
  if (fs.existsSync(EMAILS_FILE)) {
    try {
      fileEmails = JSON.parse(fs.readFileSync(EMAILS_FILE, 'utf-8'));
    } catch (e) {}
  }
  return [...new Set([...envEmails, ...fileEmails])];
}

function saveEmails(emails) {
  const envEmails = process.env.RECIPIENT_EMAILS
    ? process.env.RECIPIENT_EMAILS.split(',').map(e => e.trim()).filter(Boolean)
    : [];
  // 환경변수 목록 제외한 나머지를 파일에 저장
  fs.writeFileSync(EMAILS_FILE, JSON.stringify(emails.filter(e => !envEmails.includes(e)), null, 2));
}

// 1순위: CLHS(clhs.co.kr) 통관환율 페이지 — 관세청 과세환율과 동일 수치, 해외 접근 가능
async function fetchRatesFromClhs() {
  const res = await axios.get('https://www.clhs.co.kr/exchange.asp', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    responseType: 'arraybuffer',
    timeout: 15000,
  });
  // 페이지가 EUC-KR 인코딩이지만 통화코드·숫자는 ASCII라 그대로 파싱 가능
  const html = new TextDecoder('euc-kr').decode(res.data);

  const periodMatch = html.match(/적용기간\s*:\s*(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
  const period = periodMatch ? { from: periodMatch[1], to: periodMatch[2] } : null;

  const rates = {};
  ['USD', 'CNY', 'JPY', 'EUR'].forEach(code => {
    // 통화 행: cur=USD 링크 뒤에 수출환율(#669900), 과세환율(#FF4646) 순서
    const rowRegex = new RegExp(
      `cur=${code}"[\\s\\S]{0,800}?#669900">([\\d.]+)<[\\s\\S]{0,300}?#FF4646">([\\d.]+)<`
    );
    const m = html.match(rowRegex);
    if (m) {
      rates[code] = {
        rate: parseFloat(m[2]), // 과세환율(수입)
        exportRate: parseFloat(m[1]),
        change: null,
        period,
      };
    }
  });

  return Object.keys(rates).length > 0 ? rates : null;
}

// 2순위(fallback): 유니패스 오픈API (포트 38010, 한국 IP에서만 접근 가능)
async function fetchRatesFromUnipass() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const qryYymmDd = `${yyyy}${mm}${dd}`;
  let apiKey = process.env.UNIPASS_API_KEY;
  if (!apiKey && fs.existsSync(CONFIG_FILE)) {
    try {
      apiKey = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')).unipassApiKey;
    } catch (e) {}
  }
  if (!apiKey) throw new Error('유니패스 인증키가 설정되지 않았습니다 (UNIPASS_API_KEY)');

  const res = await axios.get(
    'https://unipass.customs.go.kr:38010/ext/rest/trifFxrtInfoQry/retrieveTrifFxrtInfo',
    {
      params: { crkyCn: apiKey, qryYymmDd, imexTp: '2' }, // 2=수입
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000,
    }
  );

  const xml = res.data;
  const rates = {};

  ['USD', 'CNY', 'JPY', 'EUR'].forEach(code => {
    const blockRegex = new RegExp(
      `<trifFxrtInfoQryRsltVo>(?:(?!<trifFxrtInfoQryRsltVo>).)*?<currSgn>${code}</currSgn>(?:(?!<trifFxrtInfoQryRsltVo>).)*?</trifFxrtInfoQryRsltVo>`,
      's'
    );
    const block = xml.match(blockRegex)?.[0];
    if (block) {
      const fxrt = block.match(/<fxrt>([\d.]+)<\/fxrt>/)?.[1];
      const aplyBgnDt = block.match(/<aplyBgnDt>(\d+)<\/aplyBgnDt>/)?.[1] || qryYymmDd;
      if (fxrt) {
        // 적용기간: 시작일(일요일)부터 6일 후(토요일)까지
        const fromDate = `${aplyBgnDt.slice(0, 4)}-${aplyBgnDt.slice(4, 6)}-${aplyBgnDt.slice(6, 8)}`;
        const end = new Date(`${fromDate}T00:00:00+09:00`);
        end.setDate(end.getDate() + 6);
        const toDate = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
        rates[code] = {
          rate: parseFloat(fxrt),
          change: null,
          period: { from: fromDate, to: toDate },
        };
      }
    }
  });

  return Object.keys(rates).length > 0 ? rates : null;
}

// 환율 조회: 유니패스 공식 API 우선, 실패 시 CLHS
async function fetchCustomsRates() {
  try {
    const rates = await fetchRatesFromUnipass();
    if (rates) {
      console.log('환율 조회 성공 (유니패스)');
      return rates;
    }
  } catch (err) {
    console.error('유니패스 환율 조회 실패:', err.message);
  }

  try {
    const rates = await fetchRatesFromClhs();
    if (rates) {
      console.log('환율 조회 성공 (CLHS)');
      return rates;
    }
  } catch (err) {
    console.error('CLHS 환율 조회 실패:', err.message);
  }

  return null;
}

// 환율 이메일 HTML 생성
function buildEmailHtml(rates, dateLabel) {
  const period = rates['USD']?.period;
  const periodStr = period ? `(${period.from} ~ ${period.to} 적용)` : '';

  const rows = ['USD', 'CNY', 'JPY', 'EUR'].map(c => {
    const d = rates[c];
    if (!d) return `<tr><td style="padding:12px 20px;font-weight:bold;">${c}</td><td colspan="3" style="padding:12px 20px;color:#999;">데이터 없음</td></tr>`;
    const changeNum = d.change != null ? parseFloat(d.change) : null;
    const arrow = changeNum == null ? '' : changeNum > 0 ? '▲' : changeNum < 0 ? '▼' : '–';
    const changeColor = changeNum == null || changeNum === 0 ? '#888' : changeNum > 0 ? '#ef4444' : '#3b82f6';
    const unit = c === 'JPY' ? '100엔' : `1${c}`;
    return `
      <tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:12px 20px;font-weight:bold;font-size:16px;width:70px;">${c}</td>
        <td style="padding:12px 20px;font-size:13px;color:#64748b;">${unit}</td>
        <td style="padding:12px 20px;text-align:right;font-size:16px;color:#1a56db;font-weight:600;">${Number(d.rate).toLocaleString()} 원</td>
        <td style="padding:12px 20px;text-align:right;font-size:13px;color:${changeColor};">${changeNum != null ? `${arrow} ${Math.abs(changeNum).toFixed(2)}` : ''}</td>
      </tr>`;
  }).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;background:#f5f7fa;padding:30px;">
  <div style="max-width:520px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
    <div style="background:#1a56db;color:#fff;padding:24px 20px;">
      <h2 style="margin:0;font-size:20px;">📊 유니패스 주간 환율 안내</h2>
      <p style="margin:6px 0 0;opacity:0.85;font-size:14px;">${dateLabel} ${periodStr}</p>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#f0f4ff;">
          <th style="padding:10px 20px;text-align:left;color:#555;font-size:13px;">통화</th>
          <th style="padding:10px 20px;text-align:left;color:#555;font-size:13px;">단위</th>
          <th style="padding:10px 20px;text-align:right;color:#555;font-size:13px;">환율</th>
          <th style="padding:10px 20px;text-align:right;color:#555;font-size:13px;">전주대비</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="padding:16px 20px;font-size:12px;color:#999;border-top:1px solid #eee;">
      출처: 관세청 유니패스(unipass.customs.go.kr) &nbsp;|&nbsp; 자동 발송 메일입니다.
    </div>
  </div>
</body>
</html>`;
}

// 이메일 발송
async function sendRateMail() {
  const config = getGmailConfig();
  if (!config.gmailUser || !config.gmailPass) {
    console.error('Gmail 설정이 없습니다. (환경변수 GMAIL_USER, GMAIL_PASS 또는 UI에서 설정)');
    return { ok: false, error: 'Gmail 설정 없음' };
  }

  const emails = loadEmails();
  if (emails.length === 0) {
    console.log('수신자 없음');
    return { ok: false, error: '수신자 없음' };
  }

  const rates = await fetchCustomsRates();
  if (!rates) return { ok: false, error: '환율 데이터를 가져오지 못했습니다.' };

  const now = new Date();
  const dateLabel = now.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  const subject = `[환율] ${dateLabel} 관세청 주간 환율`;
  const html = buildEmailHtml(rates, dateLabel);

  // 1순위: Brevo HTTP API (Railway 등 SMTP 차단 환경에서도 동작)
  if (process.env.BREVO_API_KEY) {
    try {
      await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
          sender: { name: '관세청 환율 알림', email: config.gmailUser },
          to: emails.map(e => ({ email: e })),
          subject,
          htmlContent: html,
        },
        {
          headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
          timeout: 30000,
        }
      );
      console.log(`[${new Date().toLocaleString()}] 이메일 발송 완료 (Brevo) → ${emails.length}명`);
      return { ok: true, rates, recipients: emails.length };
    } catch (err) {
      const detail = err.response?.data?.message || err.message;
      console.error('Brevo 발송 실패:', detail);
      return { ok: false, error: `Brevo 발송 실패: ${detail}` };
    }
  }

  // 2순위: Gmail SMTP (로컬/SMTP 허용 환경)
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.gmailUser, pass: config.gmailPass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });

  try {
    await transporter.sendMail({
      from: `"관세청 환율 알림" <${config.gmailUser}>`,
      to: emails.join(', '),
      subject,
      html,
    });
    console.log(`[${new Date().toLocaleString()}] 이메일 발송 완료 (Gmail) → ${emails.length}명`);
    return { ok: true, rates, recipients: emails.length };
  } catch (err) {
    console.error('메일 발송 실패:', err.message);
    return { ok: false, error: `Gmail SMTP 실패: ${err.message} (Railway에서는 SMTP가 차단되므로 BREVO_API_KEY 설정 필요)` };
  }
}

// --- API ---

app.get('/api/emails', (req, res) => res.json(loadEmails()));

app.post('/api/emails', (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: '유효하지 않은 이메일' });
  }
  const list = loadEmails();
  if (list.includes(email)) return res.status(409).json({ error: '이미 등록된 이메일' });
  list.push(email);
  saveEmails(list);
  res.json({ ok: true, emails: list });
});

app.delete('/api/emails/:email', (req, res) => {
  const target = decodeURIComponent(req.params.email);
  saveEmails(loadEmails().filter(e => e !== target));
  res.json({ ok: true, emails: loadEmails() });
});

function readConfigFile() {
  if (fs.existsSync(CONFIG_FILE)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch (e) {}
  }
  return {};
}

app.get('/api/config', (req, res) => {
  const c = getGmailConfig();
  const file = readConfigFile();
  res.json({
    gmailUser: c.gmailUser || '',
    hasPass: !!c.gmailPass,
    fromEnv: c.fromEnv,
    hasUnipassKey: !!(process.env.UNIPASS_API_KEY || file.unipassApiKey),
  });
});

app.post('/api/config', (req, res) => {
  const { gmailUser, gmailPass, unipassApiKey } = req.body;
  const current = readConfigFile();

  if (gmailUser || gmailPass) {
    if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
      return res.status(400).json({ error: 'Gmail은 환경변수로 설정되어 있어 UI에서 변경할 수 없습니다.' });
    }
    if (!gmailUser || !gmailPass) return res.status(400).json({ error: 'Gmail 주소와 앱 비밀번호를 모두 입력하세요.' });
    current.gmailUser = gmailUser;
    current.gmailPass = gmailPass;
  }
  if (unipassApiKey) current.unipassApiKey = unipassApiKey;

  saveGmailConfig(current);
  res.json({ ok: true });
});

app.post('/api/send-now', async (req, res) => {
  const result = await sendRateMail();
  res.json(result);
});

app.get('/api/rates', async (req, res) => {
  const rates = await fetchCustomsRates();
  res.json(rates || {});
});

// 매주 금요일 11:00 KST
cron.schedule('0 11 * * 5', () => {
  console.log('[CRON] 금요일 11시 - 환율 메일 발송 시작');
  sendRateMail();
}, { timezone: 'Asia/Seoul' });

const PORT = process.env.PORT || 3099;
app.listen(PORT, () => {
  console.log(`✅ 유니패스 환율 알림 서버 실행 중: http://localhost:${PORT}`);
  console.log('   매주 금요일 11:00 (KST) 자동 발송 예약됨');
  const recipientCount = loadEmails().length;
  console.log(`   수신자 ${recipientCount}명 등록됨`);
});
