/* ==========================================================================
   BACKEND: прокси к API Альфа-Банка + журнал платежей
   Node.js, без внешних зависимостей (только встроенные модули).

   ГЛАВНОЕ ПРАВИЛО БЕЗОПАСНОСТИ:
   Ключи мерчанта и данные авторизации НИКОГДА не попадают в браузер.
   Они читаются здесь из переменных окружения. Фронтенд общается
   только с этим сервером.

   ЗАПУСК (PowerShell):
     $env:ALFA_GATEWAY_URL = "https://<шлюз Альфы>"
     $env:ALFA_TERM_NO     = "<TermNo из ЛК>"
     $env:PUBLIC_BASE_URL  = "https://ваш-домен"
     $env:ALFA_AUTH_HEADER = "X-Api-Key: <ключ>"
     node server/index.js
   ========================================================================== */

'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const GATEWAY_URL = process.env.ALFA_GATEWAY_URL || '';
const TERM_NO = process.env.ALFA_TERM_NO || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
/* Авторизация в присланном разделе документации ОТСУТСТВУЕТ.
   Формат задаётся здесь; разработчик подставит то, что выдаст Альфа. */
const AUTH_HEADER = process.env.ALFA_AUTH_HEADER || '';
const AUTH_SCHEME = process.env.ALFA_AUTH_SCHEME || 'header';

const DATA_DIR = path.join(__dirname, '..', 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const MIN_AMOUNT = Number(process.env.MIN_AMOUNT || 500);
const MAX_AMOUNT = 1000000;

/* ------------------------------------------------------------------ */
/* Журнал: единственный источник правды о том, кто и за что платил     */
/* ------------------------------------------------------------------ */

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readOrders() {
  ensureDataDir();
  if (!fs.existsSync(ORDERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch (e) {
    console.error('Журнал повреждён:', e.message);
    return [];
  }
}

function writeOrders(orders) {
  ensureDataDir();
  const tmp = ORDERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2), 'utf8');
  fs.renameSync(tmp, ORDERS_FILE);
}

function saveOrder(order) {
  const orders = readOrders();
  const existing = orders.find((o) => o.qrcId === order.qrcId);
  if (existing) {
    Object.assign(existing, order);
  } else {
    orders.push(order);
  }
  writeOrders(orders);
  return existing || order;
}

function guid() {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------------ */
/* Обращение к шлюзу Альфы                                            */
/* ------------------------------------------------------------------ */

function callAlfa(payload) {
  return new Promise((resolve, reject) => {
    if (!GATEWAY_URL) {
      return reject(
        new Error(
          'ALFA_GATEWAY_URL не задан. Боевой режим требует настроек — см. README, раздел «Что нужно от Альфы».'
        )
      );
    }

    const url = new URL(GATEWAY_URL);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      Accept: 'application/json',
    };

    if (AUTH_SCHEME === 'basic') {
      headers.Authorization = 'Basic ' + Buffer.from(AUTH_HEADER).toString('base64');
    } else if (AUTH_SCHEME === 'bearer') {
      headers.Authorization = 'Bearer ' + AUTH_HEADER;
    } else if (AUTH_HEADER) {
      const idx = AUTH_HEADER.indexOf(':');
      if (idx > 0) {
        headers[AUTH_HEADER.slice(0, idx).trim()] = AUTH_HEADER.slice(idx + 1).trim();
      }
    }

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: headers,
        timeout: 30000,
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(chunks);
            /* Альфа возвращает ErrorCode != 0 даже с кодом 200 */
            if (parsed.ErrorCode && parsed.ErrorCode !== 0 && parsed.ErrorCode !== '0') {
              return reject(
                new Error('Alfa GetQRCd: ErrorCode=' + parsed.ErrorCode + ' — ' + parsed.message)
              );
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error('Ответ Альфы не разобран как JSON: ' + chunks.slice(0, 300)));
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('Таймаут обращения к шлюзу Альфы')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* Проверка данных на сервере                                          */
/*                                                                     */
/* Клиентскую проверку нельзя считать защитой: ограничение снизу       */
/* (500 ₽) в API Альфы отсутствует. Если пропустить — банк примет 300 ₽ */
/* без единого возражения.                                            */
/* ------------------------------------------------------------------ */

function validateOrder(input) {
  const errors = {};
  const out = {};

  const str = (v) => String(v == null ? '' : v).trim();

  const FIO_RE = /^[А-ЯЁа-яёA-Za-z][А-ЯЁа-яёA-Za-z\s'-]{0,49}$/;
  const GROUP_RE = /^[А-ЯЁа-яёA-Za-z0-9][А-ЯЁа-яёA-Za-z0-9\s.-]{0,19}$/;

  const last = str(input.last);
  const first = str(input.first);
  const middle = str(input.middle);

  if (!last) errors.last = 'Фамилия не заполнена';
  else if (!FIO_RE.test(last)) errors.last = 'Недопустимые символы в фамилии';

  if (!first) errors.first = 'Имя не заполнено';
  else if (!FIO_RE.test(first)) errors.first = 'Недопустимые символы в имени';

  if (middle && !FIO_RE.test(middle)) errors.middle = 'Недопустимые символы в отчестве';

  const group = str(input.group);
  if (!group) errors.group = 'Группа не заполнена';
  else if (!GROUP_RE.test(group)) errors.group = 'Недопустимые символы в группе';

  const phone = normalizePhone(str(input.phone));
  if (!phone) errors.phone = 'Некорректный номер телефона';

  const amount = Number(str(input.amount).replace(/\s/g, '').replace(',', '.'));
  if (!isFinite(amount)) errors.amount = 'Сумма не число';
  else if (Math.round(amount) !== amount) errors.amount = 'Только целые рубли';
  else if (amount < MIN_AMOUNT) errors.amount = 'Минимальная сумма — ' + MIN_AMOUNT + ' ₽';
  else if (amount > MAX_AMOUNT) errors.amount = 'Сумма выше максимальной';

  if (Object.keys(errors).length > 0) return { ok: false, errors: errors };

  const fio = [last, first, middle].filter(Boolean).join(' ');

  out.last = last;
  out.first = first;
  out.middle = middle;
  out.fio = fio;
  out.senderFio = [last, first, middle].filter(Boolean).join('|');
  out.group = group;
  out.phone = phone;
  out.amount = amount;
  out.amountMinor = Math.round(amount * 100);
  out.orderNumber = str(input.orderNumber) || makeOrderNumber();

  return { ok: true, order: out };
}

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
    digits = digits.slice(1);
  }
  if (digits.length !== 10) return null;
  return '007' + digits;
}

let seq = 0;
function makeOrderNumber() {
  seq += 1;
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return (
    'IUBIP' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '_' + seq
  );
}

/* Назначение платежа собираем ЗДЕСЬ, на сервере, а не доверяем браузеру */
function buildPurpose(order) {
  const template =
    process.env.PURPOSE_TEMPLATE ||
    'Оплата за {fio}, группа {group}, доп. образовательные услуги';
  let text = template.replace('{fio}', order.fio).replace('{group}', order.group);
  const max = 140;
  if (text.length > max) text = text.slice(0, max - 1) + '…';
  return text;
}

/* ------------------------------------------------------------------ */
/* HTTP-слой                                                          */
/* ------------------------------------------------------------------ */

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes = 1024 * 64) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Тело запроса слишком велико'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res, pathname) {
  const root = path.join(__dirname, '..');

  /* Декодируем один раз и явно: без этого percent-кодирование вида
     %2e%2e%2f даёт разные результаты в разных слоях HTTP-стека. */
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    return sendJson(res, 400, { error: 'Некорректный путь' });
  }

  /* NUL и обратные слэши приводим к прямому виду, иначе сравнение
     префиксов можно обойти другой записью того же пути. */
  decoded = decoded.replace(/\\/g, '/').replace(/\0/g, '');

  if (decoded.includes('..')) {
    return sendJson(res, 403, { error: 'Доступ запрещён' });
  }

  /* Внутренние файлы наружу не отдаём: сервер, данные, тесты */
  const BLOCKED = ['/server', '/data', '/test', '/node_modules', '/.git'];
  const rel = decoded === '/' ? '/index.html' : decoded;
  for (const b of BLOCKED) {
    if (rel === b || rel.startsWith(b + '/')) {
      return sendJson(res, 403, { error: 'Доступ запрещён' });
    }
  }

  const target = path.resolve(root, '.' + rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return sendJson(res, 403, { error: 'Доступ запрещён' });
  }

  fs.readFile(target, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Не найдено' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (e) {
    return sendJson(res, 400, { error: 'Некорректный URL' });
  }

  try {
    /* ---- Создание платежа: GetQRCd ---- */
    if (req.method === 'POST' && pathname === '/api/payments') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const v = validateOrder(body);

      if (!v.ok) {
        return sendJson(res, 400, { ok: false, error: 'Проверьте заполненные поля', errors: v.errors });
      }
      const order = v.order;
      order.purpose = buildPurpose(order);
      order.messageID = guid();

      const payload = {
        command: 'GetQRCd',
        TermNo: TERM_NO,
        qrcType: process.env.ALFA_QRC_TYPE || '02',
        amount: order.amountMinor,
        currency: 'RUB',
        paymentPurpose: order.purpose,
        OrderNumber: order.orderNumber,
        qrTtl: process.env.ALFA_QR_TTL || '30',
        width: '600',
        height: '600',
        messageID: order.messageID,
        queryData: {
          notificationUrl: PUBLIC_BASE_URL + '/api/webhook/alfa',
          SenderFIO: order.senderFio,
          SenderID: order.phone,
        },
        extJsonParams: {
          JsonParam1: order.fio,
          JsonParam2: order.group,
          JsonParam3: order.orderNumber,
          JsonParam4: order.amountMinor,
        },
      };

      const resp = await callAlfa(payload);

      /* Альфа отдаёт готовое изображение QR в base64 — клиенту ничего
         рисовать не нужно */
      let image = null;
      if (resp.image) {
        image = resp.image.startsWith('data:')
          ? resp.image
          : 'data:image/png;base64,' + resp.image;
      }

      const record = {
        qrcId: resp.qrcId,
        payrrn: resp.payrrn,
        orderNumber: order.orderNumber,
        messageID: order.messageID,
        fio: order.fio,
        senderFio: order.senderFio,
        group: order.group,
        phone: order.phone,
        amount: order.amount,
        amountMinor: order.amountMinor,
        purpose: order.purpose,
        payload: resp.payload,
        status: resp.status || 'CREATED',
        nspkStatus: null,
        trxId: null,
        trxDT: null,
        creditDatePos: null,
        payerId: null,
        createdAt: new Date().toISOString(),
        paidAt: null,
      };
      saveOrder(record);

      return sendJson(res, 200, {
        ok: true,
        stub: false,
        qrcId: resp.qrcId,
        payrrn: resp.payrrn,
        payload: resp.payload,
        image: image,
        purpose: order.purpose,
        amountMinor: order.amountMinor,
        fio: order.fio,
        group: order.group,
        orderNumber: order.orderNumber,
      });
    }

    /* ---- Статус платежа: GetQRCstatus ---- */
    const statusMatch = pathname.match(/^\/api\/payments\/([^/]+)\/status$/);
    if (req.method === 'GET' && statusMatch) {
      const qrcId = decodeURIComponent(statusMatch[1]);
      const resp = await callAlfa({
        command: 'GetQRCstatus',
        TermNo: TERM_NO,
        qrcId: qrcId,
        messageID: guid(),
      });

      /* Сверяем ответ банка с нашей записью — это независимая проверка */
      const orders = readOrders();
      const rec = orders.find((o) => o.qrcId === qrcId);
      if (rec) {
        rec.nspkStatus = resp.status || null;
        if (resp.trxId) rec.trxId = resp.trxId;
        if (resp.trxDT) rec.trxDT = resp.trxDT;
        if (resp.CreditDatePos) rec.creditDatePos = resp.CreditDatePos;
        if (resp.payerId) rec.payerId = resp.payerId;
        if (resp.amount) rec.reportedAmountMinor = resp.amount;
        if (resp.status === 'ACWP' && !rec.paidAt) rec.paidAt = new Date().toISOString();
        writeOrders(orders);
      }

      return sendJson(res, 200, {
        ok: true,
        qrcId: resp.qrcId,
        status: resp.status,
        trxId: resp.trxId,
        trxDT: resp.trxDT,
        CreditDatePos: resp.CreditDatePos,
        amount: resp.amount,
        payerId: resp.payerId,
        merchantId: resp.merchantId,
      });
    }

    /* ---- Нотификация о финальном статусе: qrc/notification ---- */
    if (req.method === 'POST' && pathname === '/api/webhook/alfa') {
      const body = JSON.parse((await readBody(req)) || '{}');

      const orders = readOrders();
      const rec = orders.find((o) => o.qrcId === body.qrcId);
      if (rec) {
        rec.nspkStatus = body.status || rec.nspkStatus;
        if (body.trxId) rec.trxId = body.trxId;
        if (body.timestamp) rec.trxDT = body.timestamp;
        if (body.CreditDatePos) rec.creditDatePos = body.CreditDatePos;
        if (body.payerId) rec.payerId = body.payerId;
        if (body.amount != null) rec.reportedAmountMinor = body.amount;
        if (body.status === 'ACWP' && !rec.paidAt) rec.paidAt = new Date().toISOString();
        rec.notifiedAt = new Date().toISOString();
        writeOrders(orders);
      } else {
        console.warn('Нотификация по неизвестному qrcId:', body.qrcId);
      }

      /* Альфа ждёт HTTP 200. Неизвестные поля в уведомлении,
         по документации, ошибкой считаться не должны. */
      return sendJson(res, 200, { ok: true });
    }

    /* ---- Выгрузка для бухгалтерии ---- */
    if (req.method === 'GET' && pathname === '/api/orders.csv') {
      const orders = readOrders();
      const header = [
        'orderNumber', 'fio', 'group', 'amount', 'amountMinor', 'purpose',
        'qrcId', 'trxId', 'nspkStatus', 'creditDatePos', 'payerId',
        'createdAt', 'paidAt',
      ];
      const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const lines = [header.join(',')];
      for (const o of orders) {
        lines.push(header.map((h) => esc(o[h])).join(','));
      }
      const body = Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': body.length,
        'Content-Disposition': 'attachment; filename="orders.csv"',
      });
      return res.end(body);
    }

    /* ---- Статические файлы ---- */
    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    return sendJson(res, 404, { error: 'Не найдено' });
  } catch (err) {
    console.error('Ошибка обработки', pathname, err.message);
    return sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log('Сервер оплаты ИУБиП: http://localhost:' + PORT);
  console.log('Режим шлюза:', GATEWAY_URL ? GATEWAY_URL : 'НЕ НАСТРОЕН (работает только демо)');
  console.log('TermNo:', TERM_NO || 'НЕ ЗАДАН');
  console.log('Минимальная сумма:', MIN_AMOUNT, '₽');
});
