/* ==========================================================================
   ВЫПУСК ФАЙЛОВ QR-КОДОВ  —  node tools/gen-qr.mjs

   Генерирует в assets/ три пары файлов (SVG + PNG):

     qr-site     — ссылка на демонстрационную страницу (GitHub Pages)
     qr-iubip    — ссылка на страницу после развёртывания на iubip.ru
     alfa-qr     — статический QR банка для оплаты через СБП

   Адреса берутся из TARGETS ниже. При смене адреса страницы выпустите
   файлы заново — QR хранит адрес внутри и не обновляется сам.

   PNG рисуется здесь же, без зависимостей: матрица QR размножается
   в пиксели и упаковывается во встроенный zlib. Смысл простой —
   генерация работает там, где нет npm-режима и интернета.
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---- Загружаем наш генератор QR (он без зависимостей и для браузера) ---- */
const src = fs.readFileSync(path.join(root, 'qr-renderer.js'), 'utf8');
(0, eval)(src);
const { QrCode } = globalThis;

/* ---- Что выпускаем --------------------------------------------------- */
const TARGETS = [
  {
    name: 'qr-site',
    url: 'https://eagle1man.github.io/iubip-sbp-pay/',
    note: 'Страница оплаты (GitHub Pages)',
  },
  {
    /* Адрес на сайте университета. Заглушка: уточняется у администратора
       iubip.ru при развёртывании. После уточнения — поменять строку
       и перезапустить скрипт. */
    name: 'qr-iubip',
    url: 'https://iubip.ru/payment/',
    note: 'Страница на сайте ИУБиП (адрес уточняется при развёртывании)',
  },
  {
    /* Статический QR банка. Ссылка раскодирована со скриншота из
       личного кабинета Альфа-Банка, картинка рисуется нашим
       генератором (qr-renderer.js) — так файл весит мало и одинаково
       читается камерой.
       ВАЖНО: статический QR не несёт сумму и ФИО — см. README. */
    name: 'alfa-qr',
    url: 'https://qr.nspk.ru/AS1A003R0QAVSGQG9H1B6KJ8U4Q9MQFI',
    note: 'Статический QR банка: оплата через СБП',
  },
];

/* ---- PNG-кодер (цветовая палитра 0: чёрно-белый 8 бит) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/* Матрица QR -> PNG. Каждый модуль — scale×scale пикселей,
   вокруг поля тишины border модулей (так читает камера). */
function matrixToPng(modules, { scale = 10, border = 4 } = {}) {
  const dim = modules.length;
  const total = (dim + border * 2) * scale;

  const raw = Buffer.alloc(total * (1 + total)); // каждая строка: фильтр 0 + байты
  let p = 0;
  for (let y = 0; y < total; y++) {
    raw[p++] = 0; // фильтр None
    const my = Math.floor(y / scale) - border;
    for (let x = 0; x < total; x++) {
      const mx = Math.floor(x / scale) - border;
      const on =
        my >= 0 && my < dim && mx >= 0 && mx < dim && modules[my][mx];
      raw[p++] = on ? 0 : 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(total, 0);
  ihdr.writeUInt32BE(total, 4);
  ihdr[8] = 8; // глубина цвета
  ihdr[9] = 0; // палитра: чёрно-белый
  // 10-12: сжатие, фильтр, интерлейс — значения по умолчанию (0)

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- Выпуск ----------------------------------------------------------- */

const outDir = path.join(root, 'assets');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
for (const t of TARGETS) {
  const matrix = QrCode.encodeToMatrix(t.url, { ecl: 'M' });
  const svg = QrCode.encodeToSvg(t.url, { size: 640, border: 4, ecl: 'M' }).svg;
  const png = matrixToPng(matrix.modules, { scale: 10, border: 4 });

  fs.writeFileSync(path.join(outDir, t.name + '.svg'), svg, 'utf8');
  fs.writeFileSync(path.join(outDir, t.name + '.png'), png);

  results.push({
    name: t.name,
    url: t.url,
    version: matrix.version,
    modules: matrix.size,
    svgBytes: Buffer.byteLength(svg),
    pngBytes: png.length,
    note: t.note,
  });
}

for (const r of results) {
  console.log(
    `${r.name}: v${r.version}, ${r.modules}×${r.modules} модулей, ` +
      `SVG ${r.svgBytes} Б, PNG ${r.pngBytes} Б\n  -> ${r.url}\n  (${r.note})`
  );
}
console.log('\nФайлы записаны в assets/');
