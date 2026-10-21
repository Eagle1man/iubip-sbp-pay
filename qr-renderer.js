/* ==========================================================================
   ГЕНЕРАТОР QR-КОДА (byte mode, версии 1-20, уровни коррекции L/M/Q/H)
   Реализация по стандарту ISO/IEC 18004. Без внешних зависимостей.

   Зачем свой, а не CDN: страницу встраивают в Bitrix и открывают
   локально, где внешний CDN может быть недоступен.

   ВНИМАНИЕ: этот генератор нужен ТОЛЬКО для демонстрационного режима (stub)
   и для офлайн-презентации. В боевом режиме (live) QR приходит от Альфы
   готовым изображением в base64 — см. alfa-sbp.js.
   ========================================================================== */

(function (global) {
  'use strict';

  /* ---- Таблицы по стандарту ------------------------------------------ */

  /* Первый индекс — уровень коррекции, второй — ВЕРСИЯ.
     Индекс 0 обязан быть -1: без него все версии съезжают на единицу
     и ёмкость считается неверно (проверено тестом). */
  var ECC_CODEWORDS_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28],
  };

  var NUM_ERROR_CORRECTION_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25],
  };

  /* Всего кодовых слов на версию (данные + коррекция).
     Таблица из стандарта, а не формула: формула легко ошибается. */
  var TOTAL_CODEWORDS = [
    26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
    404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  ];

  var ALIGNMENT_POSITIONS = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
    [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
    [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82],
    [6, 30, 58, 86], [6, 34, 62, 90],
  ];

  /* Идентификатор уровня коррекции для расчёта форматной информации.
     Это 2-битный код из старших битов 15-битного слова, НЕ само слово.
     Значения по стандарту: 01 = L, 00 = M, 11 = Q, 10 = H. */
  var FORMAT_BITS = {
    L: 0b01, M: 0b00, Q: 0b11, H: 0b10,
  };

  /* ---- Арифметика поля Галуа GF(256), примитивный многочлен 0x11D ---- */

  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  function rsGeneratorPoly(degree) {
    var result = new Uint8Array(degree);
    result[degree - 1] = 1;
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  function rsEncode(data, degree) {
    var generator = rsGeneratorPoly(degree);
    var result = new Uint8Array(degree);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ result[0];
      result.copyWithin(0, 1);
      result[degree - 1] = 0;
      for (var j = 0; j < degree; j++) {
        result[j] ^= gfMul(generator[j], factor);
      }
    }
    return result;
  }

  /* ---- Ёмкость версий в битах для byte mode ------------------------- */

  function getNumDataCodewords(version, ecl) {
    var eccLen = ECC_CODEWORDS_PER_BLOCK[ecl][version] * NUM_ERROR_CORRECTION_BLOCKS[ecl][version];
    var rawCodewords = getNumRawCodewords(version);
    return rawCodewords - eccLen;
  }

  function getNumRawCodewords(version) {
    return TOTAL_CODEWORDS[version - 1];
  }

  function getNumDataCodewordsBits(version, ecl) {
    return getNumDataCodewords(version, ecl) * 8;
  }

  function charCountBits(version) {
    return version <= 9 ? 8 : 16;
  }

  /* ---- Построение битового потока ----------------------------------- */

  function appendBits(value, length) {
    for (var i = length - 1; i >= 0; i--) {
      this.push((value >>> i) & 1);
    }
  }

  function utf8Bytes(text) {
    if (global.TextEncoder) {
      return new global.TextEncoder().encode(text);
    }
    /* Ручная реализация на случай отсутствия TextEncoder */
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff) {
        var next = text.charCodeAt(++i);
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      } else {
        bytes.push(
          0xe0 | (code >> 12),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      }
    }
    return new Uint8Array(bytes);
  }

  function buildCodewords(bytes, version, ecl) {
    var capacityBits = getNumDataCodewordsBits(version, ecl);
    var bits = [];

    bits.appendBits = appendBits;

    bits.appendBits(0x4, 4); // byte mode
    bits.appendBits(bytes.length, charCountBits(version));

    var i;
    for (i = 0; i < bytes.length; i++) {
      bits.appendBits(bytes[i], 8);
    }

    /* Терминатор и выравнивание до границы байта */
    var terminator = Math.min(4, capacityBits - bits.length);
    bits.appendBits(0, terminator);
    while (bits.length % 8 !== 0) bits.push(0);

    /* Заполнение пустот: 0xEC, 0x11 по кругу.
     ВАЖНО: это должно идти ДО сборки байтов — иначе хвост данных
     останется нулями и QR не прочитается. */
    for (var pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
      bits.appendBits(pad, 8);
    }

    var dataCapacityBytes = getNumDataCodewords(version, ecl);
    var codewords = new Uint8Array(dataCapacityBytes);
    for (var i = 0; i < capacityBits; i++) {
      codewords[i >>> 3] |= bits[i] << (7 - (i & 7));
    }

    return codewords;
  }

  /* ---- Деление на блоки и чередование -------------------------------- */

  function addEccAndInterleave(data, version, ecl) {
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][version];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][version];
    var rawCodewords = getNumRawCodewords(version);

    /* Блок, у которого данных на один байт меньше. Если деление
       делится нацело, «коротких» блоков нет и все блоки равны. */
    var numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);
    var shortDataLen = shortBlockLen - blockEccLen;

    var blocks = [];
    var k = 0;
    for (var i = 0; i < numBlocks; i++) {
      var dataLen = shortDataLen + (i < numShortBlocks ? 0 : 1);
      var dat = data.slice(k, k + dataLen);
      k += dataLen;
      blocks.push({ data: dat, ecc: rsEncode(dat, blockEccLen) });
    }

    var result = new Uint8Array(rawCodewords);
    var pos = 0;

    /* Данные чередуются по столбцам: берём i-е слово каждого блока.
       У коротких блоков последнего слова нет — его пропускаем. */
    for (var c = 0; c < shortDataLen + 1; c++) {
      for (var b = 0; b < numBlocks; b++) {
        if (c < blocks[b].data.length) result[pos++] = blocks[b].data[c];
      }
    }

    /* Слова коррекции тоже чередуются по столбцам. */
    for (var e = 0; e < blockEccLen; e++) {
      for (var eb = 0; eb < numBlocks; eb++) {
        result[pos++] = blocks[eb].ecc[e];
      }
    }

    return result;
  }

  /* ---- Матрица ------------------------------------------------------- */

  function QrMatrix(version, ecl, data) {
    this.version = version;
    this.ecl = ecl;
    this.size = version * 4 + 17;
    this.modules = [];
    this.isFunction = [];
    for (var y = 0; y < this.size; y++) {
      this.modules.push(new Array(this.size).fill(false));
      this.isFunction.push(new Array(this.size).fill(false));
    }
    this.drawFunctionPatterns();
    this.drawCodewords(data);
    this.applyMask(this.bestMask());
  }

  QrMatrix.prototype.setModule = function (x, y, dark, isFn) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = isFn;
  };

  QrMatrix.prototype.drawFunctionPatterns = function () {
    var size = this.size, i;

    /* Тайминг-линии */
    for (i = 0; i < size; i++) {
      this.setModule(6, i, i % 2 === 0, true);
      this.setModule(i, 6, i % 2 === 0, true);
    }

    /* Поисковые узоры (finder) с разделителями */
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);

    /* Выравнивающие узоры */
    var align = ALIGNMENT_POSITIONS[this.version - 1];
    for (i = 0; i < align.length; i++) {
      for (var j = 0; j < align.length; j++) {
        var skipCorner =
          (i === 0 && j === 0) ||
          (i === 0 && j === align.length - 1) ||
          (i === align.length - 1 && j === 0);
        if (!skipCorner) {
          this.drawAlignment(align[i], align[j]);
        }
      }
    }

    /* Зарезервированные области под форматную информацию и версию */
    this.drawFormatBits(0);
    this.drawVersion();
  };

  QrMatrix.prototype.drawFinder = function (cx, cy) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var x = cx + dx, y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.setModule(x, y, dist !== 2 && dist !== 4, true);
        }
      }
    }
  };

  QrMatrix.prototype.drawAlignment = function (cx, cy) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        this.setModule(
          cx + dx,
          cy + dy,
          Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          true
        );
      }
    }
  };

  QrMatrix.prototype.drawFormatBits = function (mask) {
    var data = (FORMAT_BITS[this.ecl] << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;

    var size = this.size;
    var self = this;
    /* Копии возле верхнего левого узора */
    for (i = 0; i <= 5; i++) self.setModule(8, i, getBit(bits, i), true);
    self.setModule(8, 7, getBit(bits, 6), true);
    self.setModule(8, 8, getBit(bits, 7), true);
    self.setModule(7, 8, getBit(bits, 8), true);
    for (i = 9; i < 15; i++) self.setModule(14 - i, 8, getBit(bits, i), true);

    /* Вторая копия */
    for (i = 0; i < 8; i++) self.setModule(size - 1 - i, 8, getBit(bits, i), true);
    for (i = 8; i < 15; i++) self.setModule(8, size - 15 + i, getBit(bits, i), true);
    self.setModule(8, size - 8, true, true); // тёмный модуль
  };

  QrMatrix.prototype.drawVersion = function () {
    if (this.version < 7) return;
    var rem = this.version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    var bits = (this.version << 12) | rem;
    var size = this.size;
    for (var k = 0; k < 18; k++) {
      var bit = getBit(bits, k);
      var a = size - 11 + (k % 3);
      var b = Math.floor(k / 3);
      this.setModule(a, b, bit, true);
      this.setModule(b, a, bit, true);
    }
  };

  function getBit(x, i) {
    return ((x >>> i) & 1) !== 0;
  }

  /* Размещение кодовых слов зигзагом */
  QrMatrix.prototype.drawCodewords = function (data) {
    var i = 0;
    for (var right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < this.size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };

  /* ---- Маски --------------------------------------------------------- */

  QrMatrix.prototype.applyMask = function (mask) {
    /* Функциональные узоры (поисковые, тайминг, формат) не маскируются —
       маска действует только на область данных. */
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        if (this.isFunction[y][x]) continue;
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: throw new Error('bad mask');
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
    this.mask = mask;
    this.drawFormatBits(mask);
  };

  /* Оценка по четырём штрафным правилам стандарта */
  QrMatrix.prototype.penalty = function () {
    var size = this.size, m = this.modules, result = 0, x, y, i;

    /* Правило 1: последовательности из 5 и более одинаковых модулей */
    for (y = 0; y < size; y++) {
      var runColor = m[y][0], runLen = 1;
      for (x = 1; x < size; x++) {
        if (m[y][x] === runColor) {
          runLen++;
          if (runLen === 5) result += 3;
          else if (runLen > 5) result += 1;
        } else {
          runColor = m[y][x];
          runLen = 1;
        }
      }
    }
    for (x = 0; x < size; x++) {
      var runColorV = m[0][x], runLenV = 1;
      for (y = 1; y < size; y++) {
        if (m[y][x] === runColorV) {
          runLenV++;
          if (runLenV === 5) result += 3;
          else if (runLenV > 5) result += 1;
        } else {
          runColorV = m[y][x];
          runLenV = 1;
        }
      }
    }

    /* Правило 2: блоки 2x2 одного цвета */
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) {
          result += 3;
        }
      }
    }

    /* Правило 3: паттерн 1:1:3:1:1 с четырьмя светлыми по краям */
    var pattern = [true, false, true, true, true, false, true];
    function hasPatternAt(get, start, len) {
      for (var k = 0; k < 7; k++) {
        if (get(start + k) !== pattern[k]) return false;
      }
      var before = true, after = true;
      for (var b = start - 1; b >= start - 4 && b >= 0; b--) if (!get(b)) { before = false; break; }
      for (var a = start + 7; a < start + 11 && a < len; a++) if (!get(a)) { after = false; break; }
      return before || after;
    }
    for (y = 0; y < size; y++) {
      for (x = 0; x + 7 <= size; x++) {
        if (hasPatternAt(function (i) { return m[y][i]; }, x, size)) result += 40;
      }
    }
    for (x = 0; x < size; x++) {
      for (y = 0; y + 7 <= size; y++) {
        if (hasPatternAt(function (i) { return m[i][x]; }, y, size)) result += 40;
      }
    }

    /* Правило 4: отклонение доли тёмных модулей от 50% */
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += Math.max(0, k) * 10;

    return result;
  };

  QrMatrix.prototype.bestMask = function () {
    var best = 0, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      this.applyMask(mask);
      var score = this.penalty();
      if (score < bestScore) {
        bestScore = score;
        best = mask;
      }
      /* Откат: маска — это XOR, поэтому повторное применение ТОЙ ЖЕ
         маски возвращает исходные модули. Применение маски 0 здесь
         оставляло бы матрицу искажённой. */
      this.applyMask(mask);
    }
    return best;
  };

  /* ---- Публичный API -------------------------------------------------- */

  function pickVersion(byteLength, ecl) {
    for (var v = 1; v <= 20; v++) {
      var capacityBits =
        getNumDataCodewordsBits(v, ecl) - 4 - charCountBits(v);
      if (byteLength * 8 <= capacityBits) return v;
    }
    return null;
  }

  /* Возвращает матрицу модулей — нужна скрипту выпуска файлов
     (tools/gen-qr.mjs) для растеризации в PNG. Клиентской страницей
     не используется, поэтому в API вынесена с отдельным именем. */
  function encodeToMatrix(text, opts) {
    opts = opts || {};
    var ecl = opts.ecl || 'M';

    var bytes = utf8Bytes(text);
    var version = pickVersion(bytes.length, ecl);
    if (!version) {
      throw new Error('Строка слишком длинная для QR (версия до 20): ' + bytes.length + ' байт');
    }

    var data = buildCodewords(bytes, version, ecl);
    var all = addEccAndInterleave(data, version, ecl);
    var qr = new QrMatrix(version, ecl, all);

    return { modules: qr.modules, size: qr.size, version: version, ecl: ecl };
  }

  /* Возвращает SVG-строку */
  function encodeToSvg(text, opts) {
    opts = opts || {};
    var ecl = opts.ecl || 'M';
    var border = opts.border == null ? 2 : opts.border;
    var size = opts.size || 300;

    var bytes = utf8Bytes(text);
    var version = pickVersion(bytes.length, ecl);
    if (!version) {
      throw new Error('Строка слишком длинная для QR (версия до 20): ' + bytes.length + ' байт');
    }

    var data = buildCodewords(bytes, version, ecl);
    var all = addEccAndInterleave(data, version, ecl);
    var qr = new QrMatrix(version, ecl, all);

    var dim = qr.size;
    var total = dim + border * 2;
    var parts = [];

    parts.push(
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
      '" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges" role="img" aria-label="QR-код">'
    );
    parts.push('<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>');
    parts.push('<path d="');
    for (var y = 0; y < dim; y++) {
      for (var x = 0; x < dim; x++) {
        if (qr.modules[y][x]) {
          parts.push('M' + (x + border) + ',' + (y + border) + 'h1v1h-1z');
        }
      }
    }
    parts.push('" fill="#000000"/>');
    parts.push('</svg>');

    return { svg: parts.join(''), version: version, ecl: ecl, size: dim };
  }

  global.QrCode = {
    encodeToSvg: encodeToSvg,
    encodeToMatrix: encodeToMatrix,
    utf8Bytes: utf8Bytes,
    pickVersion: pickVersion,
    /* Внутренние функции — для тестов. Клиентской страницей не
       используются, но без них невозможно проверить кодовые слова
       независимо от того, как QR «нарисуется». */
    _internals: {
      buildCodewords: buildCodewords,
      addEccAndInterleave: addEccAndInterleave,
      getNumDataCodewords: getNumDataCodewords,
      getNumRawCodewords: getNumRawCodewords,
      charCountBits: charCountBits,
      ECC_CODEWORDS_PER_BLOCK: ECC_CODEWORDS_PER_BLOCK,
      NUM_ERROR_CORRECTION_BLOCKS: NUM_ERROR_CORRECTION_BLOCKS,
      TOTAL_CODEWORDS: TOTAL_CODEWORDS,
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
