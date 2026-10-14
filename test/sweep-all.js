/* Полная проверка генератора QR: все уровни коррекции и диапазон длин.
   Сохраняет матрицы в test/sweepall.json для внешнего декодера.
   Запуск: node test/sweep-all.js */
const fs = require('fs');

const g = globalThis;
g.window = g;
for (const f of ['config.js', 'alfa-sbp.js', 'validation.js', 'qr-renderer.js']) {
  (0, eval)(fs.readFileSync(f, 'utf8'));
}

const cases = [];
const texts = [
  'A',
  'Оплата 500',
  'https://qr.nspk.ru/AD100026KQ0ESJBV8OFPCG0U9K1H52UM',
  'Оплата за Петрова Анна Ивановна, группа ГР-12, доп. образовательные услуги',
  'X'.repeat(100),
  'Я'.repeat(200),
  'Оплата за Петрова А.И., группа 5 — дополнительные образовательные услуги ИУБиП, 500 рублей',
];

for (const ecl of ['L', 'M', 'Q', 'H']) {
  for (const t of texts) {
    try {
      const r = g.QrCode.encodeToSvg(t, { ecl });
      const mods = [...r.svg.matchAll(/M(\d+),(\d+)h1v1h-1z/g)].map((m) => [
        parseInt(m[1], 10) - 2,
        parseInt(m[2], 10) - 2,
      ]);
      cases.push({ text: t, ecl, size: r.size, version: r.version, mods });
    } catch (e) {
      console.log('пропущено (слишком длинно):', ecl, t.length, '->', e.message);
    }
  }
}

fs.writeFileSync('test/sweepall.json', JSON.stringify(cases));
console.log('подготовлено случаев:', cases.length);
