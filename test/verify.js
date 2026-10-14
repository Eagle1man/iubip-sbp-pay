/* Проверка генератора QR и сборки запроса GetQRCd.
   Запуск: node test/verify.js */
const fs = require('fs');
const path = require('path');

const g = globalThis;
g.window = g;
for (const f of ['config.js', 'alfa-sbp.js', 'validation.js', 'qr-renderer.js']) {
  const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  (0, eval)(code);
}

let fails = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  OK   ' + name); }
  else { console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); fails++; }
}

console.log('\n== назначение платежа ==');
const purpose = g.AlfaSBP.buildPurpose('Петрова Анна Ивановна', 'ГР-12');
ok('не длиннее 140 символов', purpose.length <= 140, purpose.length + ': ' + purpose);
ok('содержит ФИО', purpose.includes('Петрова'));
ok('содержит группу', purpose.includes('ГР-12'));
console.log('  -> ' + purpose);

const longPurpose = g.AlfaSBP.buildPurpose(
  'Иванова Александра Николаевна-Олеговна', 'Группа-very-long-name-9999'
);
ok('обрезается до 140 при длинных данных', longPurpose.length <= 140, longPurpose.length);

console.log('\n== SenderFIO ==');
ok('через вертикальную черту',
  g.AlfaSBP.buildSenderFio('Иванов', 'Иван', 'Иванович') === 'Иванов|Иван|Иванович',
  g.AlfaSBP.buildSenderFio('Иванов', 'Иван', 'Иванович'));
ok('без отчества — две части',
  g.AlfaSBP.buildSenderFio('Петрова', 'Анна', '') === 'Петрова|Анна',
  g.AlfaSBP.buildSenderFio('Петрова', 'Анна', ''));

console.log('\n== телефон ==');
/* Формат по документации Альфы: SenderID an-11..13, пример 0079123456789
   -> 007 и ещё 10 цифр, всего 13 символов */
const PHONE_OK = '00790000000' + '00';
ok('формат 007 + 10 цифр = 13 символов', PHONE_OK.length === 13, String(PHONE_OK.length));
ok('+7 900 000-00-00', g.AlfaSBP.normalizePhone('+7 900 000-00-00') === PHONE_OK,
  g.AlfaSBP.normalizePhone('+7 900 000-00-00'));
ok('8 (900) 000-00-00', g.AlfaSBP.normalizePhone('8 (900) 000-00-00') === PHONE_OK,
  g.AlfaSBP.normalizePhone('8 (900) 000-00-00'));
ok('7 без +', g.AlfaSBP.normalizePhone('79000000000') === PHONE_OK);
ok('короткий номер отклонён', g.AlfaSBP.normalizePhone('12345') === null);

console.log('\n== суммы в копейках ==');
ok('500 руб = 50000', g.AlfaSBP.toMinorUnits(500) === 50000);
ok('1500.5 руб = 150050 копеек', g.AlfaSBP.toMinorUnits(1500.5) === 150050,
  String(g.AlfaSBP.toMinorUnits(1500.5)));
ok('мусор = 0', g.AlfaSBP.toMinorUnits('abc') === 0);

console.log('\n== валидация формы ==');
function v(o) {
  return g.Validation.buildOrder({
    last: 'Петрова', first: 'Анна', middle: 'Ивановна',
    phone: '+7 900 000-00-00', group: 'ГР-12', amount: 500, ...o,
  });
}
const good = v({});
ok('корректная форма принимается', good.ok);
ok('назначение собрано', good.ok && good.order.purpose.includes('ГР-12'));
ok('OrderNumber без кириллицы',
  good.ok && /^[A-Za-z0-9_-]+$/.test(good.order.orderNumber), good.ok && good.order.orderNumber);

ok('пустое отчество допустимо', v({ middle: '' }).ok);
ok('пустая фамилия отклонена', !v({ last: '' }).ok);
ok('без отчества должно быть поле first', !v({ first: '' }).ok);
ok('сумма 499 отклонена', !v({ amount: 499 }).ok);
ok('сумма 500 принята', v({ amount: 500 }).ok);
ok('сумма 0 отклонена', !v({ amount: 0 }).ok);
ok('дробная сумма отклонена', !v({ amount: 500.5 }).ok);
ok('ФИО с цифрами отклонено', !v({ last: 'Петрова2' }).ok);
ok('телефон 5 цифр отклонён', !v({ phone: '12345' }).ok);
ok('группа с кириллицей принята', v({ group: 'ГР-12' }).ok);
ok('группа с пробелом принята', v({ group: 'ГР 12' }).ok);
ok('группа из спецсимволов отклонена', !v({ group: '<script>' }).ok);

const minErr = v({ amount: 499 });
ok('в ошибке есть текст про 500',
  minErr.errors.amount && /500/.test(minErr.errors.amount.message),
  minErr.errors.amount && minErr.errors.amount.message);

console.log('\n== запрос GetQRCd ==');
const req = g.AlfaSBP.buildGetQRCdRequest({
  ...good.order,
});
ok('command = GetQRCd', req.command === 'GetQRCd');
ok('qrcType = 02', req.qrcType === '02');
ok('amount в копейках', req.amount === 50000, String(req.amount));
ok('currency = RUB', req.currency === 'RUB');
ok('paymentPurpose не пустой', !!req.paymentPurpose && req.paymentPurpose.length <= 140);
ok('SenderFIO передан', !!req.queryData.SenderFIO);
ok('SenderID 11-13 символов', /^007\d{10}$/.test(req.queryData.SenderID), req.queryData.SenderID);
ok('extJsonParams: ФИО', req.extJsonParams.JsonParam1 === 'Петрова Анна Ивановна');
ok('extJsonParams: группа', req.extJsonParams.JsonParam2 === 'ГР-12');
ok('extJsonParams: сумма копейками', req.extJsonParams.JsonParam4 === 50000);
ok('OrderNumber только латиница', /^[A-Za-z0-9_-]+$/.test(req.OrderNumber));
console.log('  -> ' + JSON.stringify(req).slice(0, 200) + '...');

console.log('\n== QR ==');
const svg1 = g.QrCode.encodeToSvg('https://qr.nspk.ru/AD100026KQ0ESJBV8OFPCG0U9K1H52UM');
ok('SVG создан', svg1.svg.startsWith('<svg'));
ok('SVG закрыт', svg1.svg.endsWith('</svg>'));
ok('есть чёрные модули', svg1.svg.includes('M'), '');
ok('версия выбрана', svg1.version >= 1, String(svg1.version));

const svgLong = g.QrCode.encodeToSvg(purpose);
ok('QR с кириллицей создан', svgLong.svg.startsWith('<svg'), 'v' + svgLong.version);

const bytes = g.QrCode.utf8Bytes('Анна');
ok('UTF-8: 4 байта на кириллицу', bytes.length === 8, String(bytes.length));
const bytesEmoji = g.QrCode.utf8Bytes('😀');
ok('UTF-8: суррогатные пары 4 байта', bytesEmoji.length === 4, String(bytesEmoji.length));

let threw = false;
try { g.QrCode.encodeToSvg('x'.repeat(5000)); } catch (e) { threw = true; }
ok('слишком длинная строка даёт понятную ошибку', threw);

console.log('\n== статусы ==');
ok('ACWP оплачен', g.AlfaSBP.humanStatus('ACWP') === 'Оплата зачислена');
ok('RJCT отклонён', g.AlfaSBP.humanStatus('RJCT') === 'Оплата отклонена');
ok('NTST ожидание', g.AlfaSBP.humanStatus('NTST') === 'Ожидание оплаты');

console.log('\n== таблицы блоков (сверка с эталоном) ==');
/* Эталонные значения получены из библиотеки qrcode (RS_BLOCK_TABLE
   стандарта ISO/IEC 18004). Здесь они зафиксированы, чтобы ошибка
   в таблице не прошла молча: на v19-Q, v20-Q и v19-H она уже была. */
const BLOCKS_REF = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'blocks-ref.json'), 'utf8')
);
let blockChecks = 0;
for (const ecl of ['L', 'M', 'Q', 'H']) {
  for (let v = 1; v <= 20; v++) {
    const [nBlocks, eccPerBlock] = BLOCKS_REF[v + '_' + ecl];
    /* Блоки в QR не обязаны быть равны: при делении с остатком часть
       блоков короче на одно слово. Поэтому сверяем таблицы напрямую,
       а не делимость. */
    ok(
      `v${v} ${ecl}: число блоков коррекции`,
      g.QrCode._internals.NUM_ERROR_CORRECTION_BLOCKS[ecl][v] === nBlocks,
      `у меня ${g.QrCode._internals.NUM_ERROR_CORRECTION_BLOCKS[ecl][v]}, нужно ${nBlocks}`
    );
    ok(
      `v${v} ${ecl}: слов ECC на блок`,
      g.QrCode._internals.ECC_CODEWORDS_PER_BLOCK[ecl][v] === eccPerBlock,
      `у меня ${g.QrCode._internals.ECC_CODEWORDS_PER_BLOCK[ecl][v]}, нужно ${eccPerBlock}`
    );
    blockChecks += 2;
  }
}
console.log(`  сверено значений: ${blockChecks}`);

console.log('\n== детерминированность ==');
const a = g.QrCode.encodeToSvg('ТЕСТ-ДЕТЕРМИНИЗМ').svg;
const b = g.QrCode.encodeToSvg('ТЕСТ-ДЕТЕРМИНИЗМ').svg;
ok('одинаковый текст -> одинаковый QR', a === b);

console.log('\n' + (fails === 0 ? 'ВСЕ ПРОВЕРКИ ПРОШЛИ' : fails + ' ПРОВЕР(ОК) УПАЛО'));
process.exit(fails === 0 ? 0 : 1);
