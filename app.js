/* ==========================================================================
   ЛОГИКА СТРАНИЦЫ
   Порядок ответственности:
     1. Валидация формы  — можно ли вообще переходить к оплате
     2. Прокрутка оферты — прочитал или нет
     3. Две галочки       — акцепт оферты и согласие на ПДн
     4. Оплата            — открытие внешней страницы оплаты
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
  var payLink = $('pay-link');

  var offerRead = false;
  var currentOrder = null;

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

  /* ---- Показ данных заказа ---- */
  function showFacts(order) {
    $('fact-amount').textContent = order.amount + ' ₽';
    $('fact-fio').textContent = order.fio;
    $('fact-group').textContent = order.group;
    $('fact-order').textContent = order.orderNumber;
  }

  /* ---- Оплата ----
     Данные формы на внешнюю страницу НЕ уходят: адрес в CFG.PAYMENT_URL
     фиксированный. Всё, что мы показываем здесь, — подтверждение для
     самого студента и номер заказа для бухгалтерии. */
  function startPayment() {
    var r = computeReady();
    if (!r.ready) return;

    currentOrder = r.formState.order;

    clearErrors();
    payLink.href = CFG.PAYMENT_URL;
    showFacts(currentOrder);
    payBlock.hidden = false;
    payBtn.textContent = 'Страница оплаты открыта в новой вкладке';

    /* Открываем новую вкладку тем же кликом, что и появление блока:
       так не сработает блокировщик всплывающих окон. */
    window.open(CFG.PAYMENT_URL, '_blank', 'noopener,noreferrer');

    payBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
