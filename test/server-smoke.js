/* Дымовой тест сервера: поднимаем его, бьём по API, проверяем ответы.
   Запуск: node test/server-smoke.js */
const { spawn } = require('child_process');
const http = require('http');

const PORT = 3111;
let fails = 0;

function ok(name, cond, extra) {
  if (cond) console.log('  OK   ' + name);
  else { console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); fails++; }
}

function req(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(chunks); } catch (e) { parsed = chunks; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    r.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, [__dirname + '/../server/index.js'], {
    env: { ...process.env, PORT: String(PORT), MIN_AMOUNT: '500' },
    stdio: 'ignore',
  });
  await sleep(900);

  console.log('\n== статика ==');
  const idx = await req('GET', '/');
  ok('index.html отдаётся', idx.status === 200 && String(idx.body).includes('pay-form'), String(idx.status));
  const css = await req('GET', '/style.css');
  ok('style.css отдаётся', css.status === 200);
  const js = await req('GET', '/alfa-sbp.js');
  ok('alfa-sbp.js отдаётся', js.status === 200);

  console.log('\n== обход каталога ==');
  const trav1 = await req('GET', '/../server/index.js');
  ok('обход через ../ заблокирован',
    trav1.status === 404 || trav1.status === 403, String(trav1.status));
  /* percent-кодирование — обход, который чаще всего проскакивает */
  const trav2 = await req('GET', '/%2e%2e%2f%2e%2e%2fserver%2findex.js');
  ok('обход через percent-кодирование заблокирован',
    trav2.status === 403 || trav2.status === 404, String(trav2.status));
  const trav3 = await req('GET', '/data/orders.json');
  ok('файл данных наружу не отдаётся',
    trav3.status === 403 || trav3.status === 404, String(trav3.status));
  const trav4 = await req('GET', '/server/index.js');
  ok('исходник сервера наружу не отдаётся',
    trav4.status === 403 || trav4.status === 404, String(trav4.status));

  console.log('\n== серверная валидация ==');
  const base = {
    last: 'Петрова', first: 'Анна', middle: 'Ивановна',
    phone: '+7 900 000-00-00', group: 'ГР-12', amount: 500,
  };

  const low = await req('POST', '/api/payments', { ...base, amount: 300 });
  ok('сумма 300 отклонена сервером', low.status === 400 && /Минимальная/.test(low.body.errors.amount),
    JSON.stringify(low.body).slice(0, 160));
  ok('это главная защита: в API Альфы такого ограничения нет', low.status === 400);

  const noFio = await req('POST', '/api/payments', { ...base, last: '', first: '' });
  ok('пустое ФИО отклонено', noFio.status === 400 && noFio.body.errors.last);

  const badPhone = await req('POST', '/api/payments', { ...base, phone: '123' });
  ok('плохой телефон отклонён', badPhone.status === 400 && badPhone.body.errors.phone);

  const badGroup = await req('POST', '/api/payments', { ...base, group: '<script>' });
  ok('группа со спецсимволами отклонена', badGroup.status === 400 && badGroup.body.errors.group);

  const frac = await req('POST', '/api/payments', { ...base, amount: 500.5 });
  ok('дробная сумма отклонена', frac.status === 400 && /целые/.test(frac.body.errors.amount));

  console.log('\n== боевой режим без настроек ==');
  const live = await req('POST', '/api/payments', base);
  ok('валидный заказ доходит до шлюза', live.status === 500 || live.status === 400, String(live.status));
  ok('ошибка внятная, а не «undefined»',
    live.status === 500 && /ALFA_GATEWAY_URL/.test(String(live.body.error)), String(live.body.error));
  ok('валидация прошла — ошибка не в полях', live.status === 500);

  console.log('\n== вебхук ==');
  const wh = await req('POST', '/api/webhook/alfa', {
    command: 'qrc/notification', qrcId: 'НЕИЗВЕСТНЫЙ', status: 'ACWP',
  });
  ok('вебхук отвечает 200 даже на неизвестный qrcId', wh.status === 200, String(wh.status));
  ok('ответ вебхука — ok', wh.body && wh.body.ok === true);

  const wh2 = await req('POST', '/api/webhook/alfa', {
    command: 'qrc/notification', qrcId: 'X', status: 'ACWP', неожиданноеПоле: 1,
  });
  ok('лишние поля в уведомлении не ломают приём', wh2.status === 200, String(wh2.status));

  console.log('\n== выгрузка ==');
  const csv = await req('GET', '/api/orders.csv');
  ok('CSV отдаётся', csv.status === 200, String(csv.status));
  ok('есть заголовок с ФИО и группой',
    typeof csv.body === 'string' && csv.body.includes('fio') && csv.body.includes('group'));

  console.log('\n== прочее ==');
  const nf = await req('GET', encodeURI('/нет-такого'));
  ok('404 на неизвестный путь', nf.status === 404, String(nf.status));

  srv.kill();
  console.log('\n' + (fails === 0 ? 'ВСЕ ПРОВЕРКИ ПРОШЛИ' : fails + ' ПРОВЕР(ОК) УПАЛО'));
  process.exit(fails === 0 ? 0 : 1);
})();
