/* ==========================================================================
   ЛОГИКА СТРАНИЦЫ
   Порядок ответственности:
     1. Валидация формы  — можно ли вообще переходить к оплате
     2. Прокрутка оферты — прочитал или нет
     3. Две галочки       — акцепт оферты и согласие на ПДн
     4. Оплата            — создание QR и опрос статуса
   ========================================================================== */

(function (global) {
  'use strict';

  var CFG = global.CONFIG;

  /* ---- Ссылки на элементы ---- */
  function $(id) {
    return document.getElementById(id);
  }

  var form = $('pay-form');
  var offerScroll = $('offer-scroll');
  var offerBody = $('offer-body');
  var pdBody = $('pd-body');
  var pdModal = $('pd-modal');
  var agreeOffer = $('agree-offer');
  var agreePd = $('agree-pd');
  var scrollHint = $('scroll-hint');
  var scrollDone = $('scroll-done');
  var payBtn = $('pay-btn');
  var notReady = $('not-ready');
  var payBlock = $('pay-block');
  var purposeText = $('purpose-text');
  var qrHolder = $('qr-holder');
  var qrPlaceholder = $('qr-placeholder');
  var statusBadge = $('status-badge');
  var statusDetail = $('status-detail');
  var resultBox = $('result-box');

  var offerRead = false;
  var currentOrder = null;
  var currentPayment = null;
  var pollTimer = null;
  var pollStart = 0;

  /* ---- Документы ---- */
  offerBody.innerHTML = global.OFFER_HTML;
  pdBody.innerHTML = global.PD_CONSENT_HTML;

  /* ---- Чтение ФИО ---- */
  function val(name) {
    var el = form.elements[name];
    return el ? el.value : '';
  }

  /* ---- Ошибки полей ---- */
  function clearErrors() {
    Array.prototype.forEach.call(document.querySelectorAll('.err'), function (node) {
      node.textContent = '';
      node.classList.remove('on');
    });
    Array.prototype.forEach.call(form.querySelectorAll('.input-bad'), function (node) {
      node.classList.remove('input-bad');
    });
  }

  function showErrors(errors) {
    Object.keys(errors).forEach(function (field) {
      var span = document.querySelector('.err[data-for="' + field + '"]');
      var input = form.elements[field];
      if (span) {
        span.textContent = errors[field].message;
        span.classList.add('on');
      }
      if (input) input.classList.add('input-bad');
    });
    var first = Object.keys(errors)[0];
    if (first && form.elements[first]) form.elements[first].focus();
  }

  /* ---- Превью назначения платежа ---- */
  function updatePurposePreview() {
    var fio = [val('last'), val('first'), val('middle')].join(' ').trim();
    var group = val('group').trim();
    var amount = val('amount').trim();

    if (!fio && !group) {
      purposeText.textContent = '—';
      return;
    }

    var text = global.AlfaSBP.buildPurpose(fio || 'ФИО', group || 'группа');
    purposeText.textContent = amount
      ? text + ' — ' + amount + ' ₽'
      : text;
  }

  /* ---- Готовность к оплате ---- */
  function computeReady() {
    var formState = global.Validation.buildOrder({
      last: val('last'),
      first: val('first'),
      middle: val('middle'),
      phone: val('phone'),
      group: val('group'),
      amount: val('amount'),
    });

    var consentOk = Boolean(agreeOffer.checked && agreePd.checked);
    var ready = formState.ok && offerRead && consentOk;

    return { formState: formState, consentOk: consentOk, ready: ready };
  }

  function refreshPayButton() {
    var r = computeReady();

    payBtn.disabled = !r.ready;

    if (r.ready) {
      notReady.textContent = 'Всё готово к оплате.';
      notReady.classList.add('ok');
      payBtn.textContent =
        'Оплатить ' + r.formState.order.amount + ' ₽ через СБП';
    } else {
      notReady.classList.remove('ok');
      payBtn.textContent = 'Перейти к оплате';
      if (!r.formState.ok) {
        notReady.textContent =
          'Заполните все обязательные поля, подтвердите оферту и согласие на обработку персональных данных.';
      } else if (!offerRead) {
        notReady.textContent = 'Прокрутите текст оферты до конца.';
      } else {
        notReady.textContent = 'Подтвердите оферту и согласие на обработку персональных данных.';
      }
    }

    updatePurposePreview();
  }

  /* ---- Прокрутка оферты ---- */
  function onOfferScroll() {
    if (offerRead) return;
    var remaining =
      offerScroll.scrollHeight - offerScroll.scrollTop - offerScroll.clientHeight;
    /* +8 — допуск на субпиксельные округления, иначе на части устройств
       «дочитал» засчитать не даётся */
    if (remaining <= 8) {
      offerRead = true;
      agreeOffer.disabled = false;
      scrollHint.hidden = true;
      scrollDone.hidden = false;
      refreshPayButton();
    }
  }

  /* ---- Показ QR ---- */
  function renderQr(qrDataOrImage) {
    qrPlaceholder.hidden = true;
    qrHolder.innerHTML = '';

    if (!qrDataOrImage) {
      qrPlaceholder.hidden = false;
      return;
    }

    /* Готовое изображение: base64 от Альфы или файл в assets/ */
    if (
      qrDataOrImage.indexOf('data:image') === 0 ||
      /\.(svg|png)$/i.test(qrDataOrImage)
    ) {
      var img = document.createElement('img');
      img.src = qrDataOrImage;
      img.alt = 'QR-код для оплаты через СБП';
      qrHolder.appendChild(img);
      return;
    }

    /* В демо-режиме рисуем QR сами — см. qr-renderer.js */
    try {
      var result = global.QrCode.encodeToSvg(qrDataOrImage, { size: 300, ecl: 'M' });
      qrHolder.innerHTML = result.svg;
    } catch (e) {
      qrPlaceholder.hidden = false;
      qrPlaceholder.innerHTML =
        '<span>Не удалось построить QR</span><small>' +
        String(e.message).slice(0, 120) + '</small>';
    }
  }

  function setBadge(text, state) {
    statusBadge.textContent = text;
    statusBadge.className = 'badge' + (state ? ' badge-' + state : '');
  }

  function showFacts(order, payment) {
    $('fact-amount').textContent = order.amount + ' ₽';
    $('fact-fio').textContent = order.fio;
    $('fact-group').textContent = order.group;
    $('fact-order').textContent = order.orderNumber;
    $('fact-qrcid').textContent = payment ? payment.qrcId : '—';
  }

  /* ---- Оплата ---- */
  function startPayment() {
    var r = computeReady();
    if (!r.ready) return;

    currentOrder = r.formState.order;
    var adapter = global.AlfaSBP.current();

    clearErrors();
    payBtn.disabled = true;
    payBtn.textContent = 'Создаём QR-код…';
    notReady.textContent = 'Регистрируем платёж…';
    notReady.classList.add('ok');

    adapter
      .createPayment(currentOrder)
      .then(function (payment) {
        if (!payment.ok) {
          throw new Error(payment.error || 'Банк отклонил создание платежа');
        }
        currentPayment = payment;
        payBlock.hidden = false;
        /* Показываем статический QR банка. В боевом режиме приходит
           изображение от Альфы — см. выше. */
        renderQr(
          payment.stub && CFG.STATIC_QR_SRC
            ? CFG.STATIC_QR_SRC
            : payment.image || payment.qrData || payment.payload
        );
        showFacts(currentOrder, payment);
        setBadge('Ожидание оплаты', 'wait');
        statusDetail.textContent = 'Отсканируйте код в приложении банка.';
        payBtn.textContent = 'QR создан — ожидаем оплату';
        startPolling();
      })
      .catch(function (err) {
        payBtn.disabled = false;
        payBtn.textContent = 'Попробовать снова';
        notReady.classList.remove('ok');
        notReady.textContent = 'Не удалось создать платёж: ' + err.message;
        setBadge('Ошибка создания платежа', 'err');
        statusDetail.textContent = err.message;
      });
  }

  /* ---- Опрос статуса ----
     Ограничения Альфы: GetQRCstatus не раньше чем через 10 секунд
     после создания QR и не чаще одного раза в 3 секунды. */
  function startPolling() {
    if (currentPayment && currentPayment.stub) {
      /* В демо-режиме оплата невозможна — не мучаем сеть опросом */
      return;
    }
    pollStart = Date.now();
    setTimeout(pollOnce, CFG.STATUS_FIRST_DELAY_MS);
  }

  function pollOnce() {
    if (!currentPayment) return;

    global.AlfaSBP.current()
      .getStatus(currentPayment.qrcId, currentPayment.payrrn)
      .then(function (res) {
        if (res.ok && res.status === CFG.STATUS_ACCEPTED) {
          stopPolling();
          setBadge('Оплата получена', 'ok');
          statusDetail.textContent =
            'Платёж зачислен ' + (res.CreditDatePos || '') + ', trxId ' + (res.trxId || '');
          showResult(true, res);
          return;
        }
        if (res.ok && res.status === CFG.STATUS_REJECTED) {
          stopPolling();
          setBadge('Оплата отклонена', 'err');
          statusDetail.textContent = 'Платёж отклонён банком плательщика.';
          showResult(false, res);
          return;
        }
        /* NTST или RCVD — продолжаем ждать */
        setBadge(global.AlfaSBP.humanStatus(res.status), 'wait');
        pollTimer = setTimeout(pollOnce, CFG.STATUS_POLL_INTERVAL_MS);
      })
      .catch(function (err) {
        statusDetail.textContent = 'Ошибка запроса статуса: ' + err.message;
        pollTimer = setTimeout(pollOnce, CFG.STATUS_POLL_INTERVAL_MS);
      });
  }

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function showResult(paid, res) {
    resultBox.hidden = false;
    resultBox.className = 'result-box ' + (paid ? 'result-ok' : 'result-err');
    resultBox.innerHTML = paid
      ? '<strong>Оплата зачислена.</strong><br>' +
        'Сохраните номер заказа: <code>' + currentOrder.orderNumber + '</code>.<br>' +
        'Договор вступает в силу с момента поступления средств на счёт ' +
        'Исполнителя (п. 5.6 оферты).'
      : '<strong>Оплата не прошла.</strong><br>' +
        'Попробуйте ещё раз или обратитесь в бухгалтерию ИУБиП.';
  }

  /* ---- Модальное окно ПДн ---- */
  function openPd() {
    pdModal.hidden = false;
    document.body.classList.add('modal-open');
  }
  function closePd() {
    pdModal.hidden = true;
    document.body.classList.remove('modal-open');
  }

  /* ---- События ---- */
  form.addEventListener('input', function () {
    clearErrors();
    refreshPayButton();
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
  });

  offerScroll.addEventListener('scroll', onOfferScroll);
  offerScroll.addEventListener('wheel', onOfferScroll);
  offerScroll.addEventListener('touchmove', onOfferScroll);
  /* На клавиатуре полный скролл не всегда доходит до конца —
     проверяем положение и по событию keyup */
  offerScroll.addEventListener('keyup', onOfferScroll);

  /* Если оферта помещается целиком и прокручивать нечего */
  setTimeout(function () {
    if (offerScroll.scrollHeight <= offerScroll.clientHeight + 8) {
      onOfferScroll();
    }
  }, 100);

  agreeOffer.addEventListener('change', refreshPayButton);
  agreePd.addEventListener('change', refreshPayButton);
  payBtn.addEventListener('click', startPayment);

  $('pd-open').addEventListener('click', openPd);
  $('pd-close').addEventListener('click', closePd);
  pdModal.addEventListener('click', function (e) {
    if (e.target === pdModal) closePd();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !pdModal.hidden) closePd();
  });

  /* ---- Логотип ----
     Путь к нему может быть задан в data-logo-src. Если картинка по этому
     пути не пришла, пробуем варианты рядом со страницей: положить
     assets/ внутрь папки раздела проще, чем разбираться с абсолютными
     путями при переносе на Bitrix. */
  (function resolveLogo() {
    var img = document.querySelector('[data-logo-src]');
    if (!img) return;

    var candidates = [
      img.getAttribute('data-logo-src'),
      '../assets/iubip-logo.svg',
      'assets/iubip-logo.svg',
      '/assets/iubip-logo.svg',
    ].filter(Boolean);

    var i = 0;
    function tryNext() {
      if (i >= candidates.length) {
        /* Логотип не критичен для оплаты: оставляем текст, убираем
           пустое место, чтобы не было дыры в шапке. */
        var box = document.querySelector('.brand-logo');
        if (box) box.style.display = 'none';
        return;
      }
      var url = candidates[i++];
      img.onload = function () {
        img.removeAttribute('data-logo-src');
      };
      img.onerror = tryNext;
      img.src = url;
    }
    tryNext();
  })();

  /* ---- Старт ---- */
  refreshPayButton();
})(window);
