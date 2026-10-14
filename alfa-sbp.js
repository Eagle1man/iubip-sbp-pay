/* ==========================================================================
   АДАПТЕР ОПЛАТЫ СБП «АЛЬФА-БАНК»
   Реализован по официальной документации Alfa-Bank «Динамический QR-код».

   ТРИ МЕТОДА API:
     GetQRCd       — регистрация динамического QR (создание платежной ссылки)
     GetQRCstatus  — запрос статуса оплаты по qrcId
     qrc/notification — входящая нотификация о финальном статусе (обрабатывает backend)

   ВАЖНО ПРО НАЗНАЧЕНИЕ ПЛАТЕЖА:
     Альфа НЕ извлекает ФИО из QR. В ответах приходит только
     payerId — маскированный телефон плательщика. Всё, что увидит
     бухгалтерия, — это то, что МЫ САМИ зашили в paymentPurpose
     и extJsonParams при регистрации.
   ========================================================================== */

(function (global) {
  'use strict';

  var CFG = global.CONFIG;

  /* ------------------------------------------------------------------
     Назначение платежа — то, что увидит плательщик и попадёт в выгрузку.
     Ограничение API: ans-140 (не более 140 символов).
     ------------------------------------------------------------------ */
  function buildPurpose(fio, group) {
    var text = CFG.PURPOSE_TEMPLATE
      .replace('{fio}', fio)
      .replace('{group}', group);
    if (text.length > CFG.PURPOSE_MAX) {
      text = text.slice(0, CFG.PURPOSE_MAX - 1) + '…';
    }
    return text;
  }

  /* ФИО для SenderFIO. Формат по документации — через вертикальную черту,
     регистр не важен. Пример из документации: "Иванов|Иван|Иванович" */
  function buildSenderFio(last, first, middle) {
    return [last, first, middle]
      .filter(Boolean)
      .map(function (p) { return p.trim(); })
      .join('|');
  }

  /* Номер телефона в формате, требуемом API: 0079123456789 (11 цифр после 007 — нет,
     по документации an-11..13, пример 0079123456789). Приводим 7/8/+7/007 к 007XXXXXXXXXX */
  function normalizePhone(raw) {
    var digits = String(raw || '').replace(/\D/g, '');
    if (digits.length === 11 && digits[0] === '7') {
      digits = digits.slice(1);
    } else if (digits.length === 11 && digits[0] === '8') {
      digits = digits.slice(1);
    }
    if (digits.length === 10) {
      return '007' + digits;
    }
    return null;
  }

  /* Сумма в копейках — API требует минорные единицы.
     Валидацию минимума делает app.js ДО вызова. Здесь страховка. */
  function toMinorUnits(rubles) {
    var value = Number(rubles);
    if (!isFinite(value)) return 0;
    return Math.round(value * 100);
  }

  /* Полный текст ошибки Альфы: ErrorCode + message */
  function describeError(code, message) {
    return 'Alfa SBP error ' + code + ': ' + (message || 'без расшифровки');
  }

  /* ------------------------------------------------------------------
     Адаптер: режим 'stub' (демонстрация без банка)
     ------------------------------------------------------------------ */
  var StubAdapter = {
    name: 'stub',

    isStub: true,

    /* Имитирует GetQRCd. Ничего не отправляет в банк.
       Для показа и для GitHub Pages, где бэкенда нет. */
    createPayment: function (order) {
      return new Promise(function (resolve) {
        var qrcId = 'STUB-' + Math.random().toString(36).slice(2, 12).toUpperCase();
        var qrData =
          'STUB-QR|' +
          encodeURIComponent(order.purpose) +
          '|AMOUNT=' + toMinorUnits(order.amount) +
          '|GROUP=' + encodeURIComponent(order.group);

        global.console.info('[STUB] GetQRCd (имитация)', {
          command: 'GetQRCd',
          TermNo: CFG.TERM_NO || 'STUB',
          qrcType: CFG.ALFA_QRC_TYPE,
          amount: toMinorUnits(order.amount),
          currency: CFG.ALFA_CURRENCY,
          paymentPurpose: order.purpose,
          OrderNumber: order.orderNumber,
          SenderFIO: order.senderFio,
          SenderID: order.senderId,
          qrTtl: CFG.ALFA_QR_TTL,
          notificationUrl: CFG.NOTIFICATION_URL,
          extJsonParams: {
            JsonParam1: order.fio,
            JsonParam2: order.group,
            JsonParam3: order.orderNumber,
            JsonParam4: toMinorUnits(order.amount),
          },
        });

        resolve({
          ok: true,
          stub: true,
          qrcId: qrcId,
          payrrn: 'STUBREF000001',
          qrData: qrData,
          purpose: order.purpose,
          amountMinor: toMinorUnits(order.amount),
          fio: order.fio,
          group: order.group,
          orderNumber: order.orderNumber,
          phone: order.senderId,
          createdAt: new Date().toISOString(),
        });
      });
    },

    /* Имитирует GetQRCstatus. Никогда не подтверждает оплату —
       реальных денег нет. */
    getStatus: function () {
      return Promise.resolve({
        ok: true,
        status: CFG.STATUS_NOT_STARTED,
        stub: true,
      });
    },
  };

  /* ------------------------------------------------------------------
     Адаптер: режим 'live' (реальный банк через наш backend)
     ВАЖНО: ключи мерчанта живут ТОЛЬКО на сервере. Здесь их нет и быть не должно.
     ------------------------------------------------------------------ */
  var LiveAdapter = {
    name: 'live',

    isStub: false,

    createPayment: function (order) {
      return global
        .fetch(CFG.API_BASE + '/payments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fio: order.fio,
            last: order.last,
            first: order.first,
            middle: order.middle,
            phone: order.senderId,
            group: order.group,
            amount: order.amount,
            purpose: order.purpose,
            orderNumber: order.orderNumber,
          }),
        })
        .then(function (res) {
          return res.json().then(function (body) {
            if (!res.ok) {
              throw new Error(body.error || ('HTTP ' + res.status));
            }
            return body;
          });
        });
    },

    /* По документации Альфы: GetQRCstatus нельзя вызывать ранее чем
       через 10 секунд после создания QR и не чаще раза в 3 секунды.
       Эти ограничения держит app.js, а не адаптер. */
    getStatus: function (qrcId, payrrn) {
      var url =
        CFG.API_BASE + '/payments/' + encodeURIComponent(qrcId) + '/status';
      if (payrrn) url += '?payrrn=' + encodeURIComponent(payrrn);
      return global
        .fetch(url, { method: 'GET' })
        .then(function (res) {
          return res.json().then(function (body) {
            if (!res.ok) {
              throw new Error(body.error || ('HTTP ' + res.status));
            }
            return body;
          });
        });
    },
  };

  /* ------------------------------------------------------------------
     Сборка запроса GetQRCd.
     Вынесена отдельно, чтобы её можно было показать и проверить
     без сетевого вызова — она же уходит на backend тем же составом полей.
     ------------------------------------------------------------------ */
  function buildGetQRCdRequest(order) {
    return {
      command: 'GetQRCd',
      TermNo: CFG.TERM_NO,
      qrcType: CFG.ALFA_QRC_TYPE,
      amount: toMinorUnits(order.amount),
      currency: CFG.ALFA_CURRENCY,
      paymentPurpose: order.purpose,
      OrderNumber: order.orderNumber,
      qrTtl: CFG.ALFA_QR_TTL,
      width: '600',
      height: '600',
      queryData: {
        notificationUrl: CFG.NOTIFICATION_URL,
        SenderFIO: order.senderFio,
        SenderID: order.senderId,
      },
      extJsonParams: {
        JsonParam1: order.fio,
        JsonParam2: order.group,
        JsonParam3: order.orderNumber,
        JsonParam4: toMinorUnits(order.amount),
      },
    };
  }

  /* Сборка запроса GetQRCstatus */
  function buildGetQRCstatusRequest(qrcId, payrrn, messageId) {
    var req = {
      command: 'GetQRCstatus',
      TermNo: CFG.TERM_NO,
      messageID: messageId,
    };
    if (qrcId) req.qrcId = qrcId;
    if (payrrn) req.payrrn = payrrn;
    return req;
  }

  /* Декодирование статуса НСПК для показа человеку */
  function humanStatus(status) {
    switch (status) {
      case 'ACWP':
        return 'Оплата зачислена';
      case 'RJCT':
        return 'Оплата отклонена';
      case 'RCVD':
        return 'Платёж обрабатывается';
      case 'NTST':
        return 'Ожидание оплаты';
      default:
        return status || 'неизвестный статус';
    }
  }

  global.AlfaSBP = {
    buildPurpose: buildPurpose,
    buildSenderFio: buildSenderFio,
    normalizePhone: normalizePhone,
    toMinorUnits: toMinorUnits,
    describeError: describeError,
    buildGetQRCdRequest: buildGetQRCdRequest,
    buildGetQRCstatusRequest: buildGetQRCstatusRequest,
    humanStatus: humanStatus,
    stub: StubAdapter,
    live: LiveAdapter,
    current: function () {
      return CFG.MODE === 'live' ? LiveAdapter : StubAdapter;
    },
  };
})(window);
