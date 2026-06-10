const express = require('express');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Gmail 설정: 환경변수에서 읽기
function getGmailConfig() {
  return { gmailUser: process.env.GMAIL_USER, gmailPass: process.env.GMAIL_PASS };
}

// 이메일 목록: 환경변수(기본값) + 런타임 추가목록 합산
// RECIPIENT_EMAILS=a@a.com,b@b.com 으로 기본 수신자 지정
// UI에서 추가한 이메일은 메모리에 유지 (재시작 시 초기화되나 환경변수 목록은 유지)
let runtimeEmails = []; // UI에서 추가된 이메일 (메모리)

function loadEmails() {
  const envEmails = process.env.RECIPIENT_EMAILS
    ? process.env.RECIPIENT_EMAILS.split(',').map(e => e.trim()).filter(Boolean)
    : [];
  // 중복 제거 후 합산
  const all = [...new Set([...envEmails, ...runtimeEmails])];
  return all;
}

function saveEmails(emails) {
  // 환경변수 목록을 제외한 UI 추가분만 메모리에 저장
  const envEmails = process.env.RECIPIENT_EMAILS
    ? process.env.RECIPIENT_EMAILS.split(',').map(e => e.trim()).filter(Boolean)
    : [];
  runtimeEmails = emails.filter(e => !envEmails.includes(e));
}

// 유니패스 주간환율 API 호출
async function fetchCustomsRates() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const aplyDt = `${yyyy}-${mm}-${dd}`;

  try {
    const res = await axios.get(
      'https://unipass.customs.go.kr/csp/myc/bsopspptinfo/dclrSpptInfo/WeekFxrtQryCtr/retrieveWeekFxrt.do',
      {
        params: { pageIndex: 1, pageUnit: 100, orderColumns: 'RNUM asc', aplyDt, weekFxrtTpcd: 1 },
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://unipass.customs.go.kr/csp/index.do',
          Accept: 'application/json, text/javascript, */*',
        },
        timeout: 15000,
      }
    );

    const items = res.data?.items || [];
    const rates = {};

    ['USD', 'CNY', 'JPY', 'EUR'].forEach(code => {
      const item = items.find(i => i.currCd === code);
      if (item) {
        rates[code] = {
          rate: item.weekFxrt,
          prev: item.beforeWeekFxrt,
          change: item.riseFall,
          name: item.currNm,
          period: { from: res.data.aplyDtStrtDd, to: res.data.aplyDtEndDd },
        };
      }
    });

    return Object.keys(rates).length > 0 ? rates : null;
  } catch (err) {
    console.error('유니패스 환율 조회 실패:', err.message);
    return null;
  }
}

// 환율 이메일 HTML 생성
function buildEmailHtml(rates, dateLabel) {
  const period = rates['USD']?.period;
  const periodStr = period ? `(${period.from} ~ ${period.to} 적용)` : '';

  const rows = ['USD', 'CNY', 'JPY', 'EUR'].map(c => {
    const d = rates[c];
    if (!d) return `<tr><td style="padding:12px 20px;font-weight:bold;">${c}</td><td colspan="3" style="padding:12px 20px;color:#999;">데이터 없음</td></tr>`;
    const changeNum = parseFloat(d.change);
    const arrow = changeNum > 0 ? '▲' : changeNum < 0 ? '▼' : '–';
    const changeColor = changeNum > 0 ? '#ef4444' : changeNum < 0 ? '#3b82f6' : '#888';
    const unit = c === 'JPY' ? '100엔' : `1${c}`;
    return `
      <tr style="border-bottom:1px solid #f1f5f9;">
        <td style="padding:12px 20px;font-weight:bold;font-size:16px;width:70px;">${c}</td>
        <td style="padding:12px 20px;font-size:13px;color:#64748b;">${unit}</td>
        <td style="padding:12px 20px;text-align:right;font-size:16px;color:#1a56db;font-weight:600;">${Number(d.rate).toLocaleString()} 원</td>
        <td style="padding:12px 20px;text-align:right;font-size:13px;color:${changeColor};">${arrow} ${Math.abs(changeNum).toFixed(2)}</td>
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

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.gmailUser, pass: config.gmailPass },
  });

  try {
    await transporter.sendMail({
      from: `"유니패스 환율 알림" <${config.gmailUser}>`,
      to: emails.join(', '),
      subject: `[환율] ${dateLabel} 유니패스 주간 환율`,
      html: buildEmailHtml(rates, dateLabel),
    });
    console.log(`[${new Date().toLocaleString()}] 이메일 발송 완료 → ${emails.length}명`);
    return { ok: true, rates, recipients: emails.length };
  } catch (err) {
    console.error('메일 발송 실패:', err.message);
    return { ok: false, error: err.message };
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

app.get('/api/config', (req, res) => {
  const c = getGmailConfig();
  res.json({ gmailUser: c.gmailUser || '', hasPass: !!c.gmailPass, fromEnv: true });
});

app.post('/api/config', (req, res) => {
  res.status(400).json({ error: 'Railway 대시보드 Variables에서 GMAIL_USER, GMAIL_PASS를 변경하세요.' });
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
