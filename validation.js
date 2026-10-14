/* ==========================================================================
   ВАЛИДАЦИЯ ФОРМЫ
   Все правила собраны здесь, чтобы «можно оплатить» и «нельзя оплатить»
   определялись одним местом.
   ========================================================================== */

(function (global) {
  'use strict';

  var CFG = global.CONFIG;

  /* Только буквы (кириллица и латиница), пробел, дефис, апостроф.
     Цифры и точки в ФИО не допускаем — это отсекает мусор и опечатки. */
  var FIO_RE = /^[А-ЯЁа-яёA-Za-z][А-ЯЁа-яёA-Za-z\s'-]{0,49}$/;

  /* Группа: буквы, цифры, дефисы, точки, пробелы. «ГР-12», «5», «А1» и т.п. */
  var GROUP_RE = /^[А-ЯЁа-яёA-Za-z0-9][А-ЯЁа-яёA-Za-z0-9\s.-]{0,19}$/;

  function validateField(kind, value) {
    var v = String(value == null ? '' : value).trim();

    if (!v) {
      return { ok: false, code: 'EMPTY', message: 'Поле не заполнено' };
    }

    if (kind === 'last' || kind === 'first' || kind === 'middle') {
      if (!FIO_RE.test(v)) {
        return {
          ok: false,
          code: 'FORMAT',
          message: 'Только буквы, пробел и дефис',
        };
      }
      return { ok: true, value: v };
    }

    if (kind === 'group') {
      if (!GROUP_RE.test(v)) {
        return {
          ok: false,
          code: 'FORMAT',
          message: 'Допустимы буквы, цифры, точка и дефис',
        };
      }
      return { ok: true, value: v };
    }

    if (kind === 'phone') {
      var normalized = global.AlfaSBP.normalizePhone(v);
      if (!normalized) {
        return {
          ok: false,
          code: 'PHONE',
          message: 'Нужен номер телефона — 10 цифр после 7 или 8',
        };
      }
      return { ok: true, value: normalized };
    }

    if (kind === 'amount') {
      var cleaned = v.replace(/\s/g, '').replace(',', '.');
      var num = Number(cleaned);

      if (!isFinite(num) || isNaN(num)) {
        return { ok: false, code: 'AMOUNT', message: 'Сумма должна быть числом' };
      }
      if (Math.round(num) !== num) {
        return { ok: false, code: 'AMOUNT', message: 'Только целые рубли' };
      }
      if (num < CFG.MIN_AMOUNT) {
        return {
          ok: false,
          code: 'MIN',
          message: 'Минимальная сумма — ' + CFG.MIN_AMOUNT + ' ₽',
        };
      }
      if (num > CFG.MAX_AMOUNT) {
        return {
          ok: false,
          code: 'MAX',
          message: 'Максимальная сумма — ' + CFG.MAX_AMOUNT + ' ₽',
        };
      }
      return { ok: true, value: num };
    }

    return { ok: true, value: v };
  }

  /* Номер заказа для OrderNumber.
     ВАЖНО: по документации разрешены только английские буквы, цифры,
     подчёркивание и дефис. ФИО сюда писать нельзя — оно уедет в errors. */
  var orderSeq = 0;
  function makeOrderNumber() {
    orderSeq += 1;
    var d = new Date();
    function pad(n) {
      return n < 10 ? '0' + n : String(n);
    }
    return (
      'IUBIP' +
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds()) +
      '_' +
      orderSeq
    );
  }

  /* Набор обязательных полей.
     Отчество необязательно — на это указывает и форма, и оферта
     (акцепт по ст. 438 ГК РФ не требует отчества). */
  var REQUIRED = ['last', 'first', 'phone', 'group', 'amount'];
  var ALL_FIELDS = ['last', 'first', 'middle', 'phone', 'group', 'amount'];

  /* Сборка заказа из формы + проверка всего набора полей */
  function buildOrder(form) {
    var fields = {};
    ALL_FIELDS.forEach(function (kind) {
      fields[kind] = form[kind];
    });

    var errors = {};
    var clean = {};

    ALL_FIELDS.forEach(function (kind) {
      var raw = fields[kind];
      var isEmpty = String(raw == null ? '' : raw).trim() === '';

      if (isEmpty) {
        if (REQUIRED.indexOf(kind) !== -1) {
          errors[kind] = { ok: false, code: 'EMPTY', message: 'Поле не заполнено' };
        } else {
          clean[kind] = ''; /* необязательное поле — норма */
        }
        return;
      }

      var res = validateField(kind, raw);
      if (!res.ok) {
        errors[kind] = res;
      } else {
        clean[kind] = res.value;
      }
    });

    if (Object.keys(errors).length > 0) {
      return { ok: false, errors: errors };
    }

    var fio = [clean.last, clean.first, clean.middle].join(' ');

    return {
      ok: true,
      order: {
        last: clean.last,
        first: clean.first,
        middle: clean.middle,
        fio: fio,
        senderFio: global.AlfaSBP.buildSenderFio(
          clean.last,
          clean.first,
          clean.middle
        ),
        phone: clean.phone,
        senderId: clean.phone,
        group: clean.group,
        amount: clean.amount,
        amountMinor: global.AlfaSBP.toMinorUnits(clean.amount),
        orderNumber: makeOrderNumber(),
        purpose: global.AlfaSBP.buildPurpose(fio, clean.group),
      },
    };
  }

  global.Validation = {
    validateField: validateField,
    buildOrder: buildOrder,
    makeOrderNumber: makeOrderNumber,
  };
})(window);
