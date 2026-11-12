/*
 * 子育て支援の予約カレンダー ＆ お問い合わせフォーム
 * データの保存とメール送信は Google Apps Script（gas/Code.gs）が行います。
 *   <div class="sk-booking" data-calendar="kids|land"></div>
 *   <div class="sk-contact"></div>
 */
(function () {
  'use strict';
  var CFG = window.SK_CONFIG || {};
  var API = CFG.gasUrl;
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] !== undefined) el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  function get(params) {
    var q = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    return fetch(API + '?' + q).then(function (r) { return r.json(); });
  }
  function post(data) {
    // text/plain にすると Apps Script でも事前確認なしで送れる
    return token().then(function (t) {
      data.recaptchaToken = t;
      return fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(data) });
    }).then(function (r) { return r.json(); });
  }
  var recaptchaReady = null;
  function token() {
    if (!CFG.recaptchaKey) return Promise.resolve('');
    if (!recaptchaReady) {
      recaptchaReady = new Promise(function (res) {
        var s = document.createElement('script');
        s.src = 'https://www.google.com/recaptcha/api.js?render=' + CFG.recaptchaKey;
        s.onload = function () { window.grecaptcha.ready(res); };
        document.head.appendChild(s);
      });
    }
    return recaptchaReady.then(function () { return window.grecaptcha.execute(CFG.recaptchaKey, { action: 'submit' }); });
  }

  function notReady(el) {
    el.appendChild(h('p', { class: 'sk-msg', text: '現在、ネットでの受付を準備中です。お電話（029-219-0007）でお申し込みください。' }));
  }

  // ---------------------------------------------------------------- 入力フォーム
  function buildFields(fields) {
    var wrap = h('div', { class: 'sk-fields' });
    fields.forEach(function (f) {
      var id = 'sk-' + f.id;
      var input;
      if (f.type === 'textarea') {
        input = h('textarea', { id: id, name: f.id, rows: 4, placeholder: f.placeholder, required: f.required });
      } else if (f.type === 'select') {
        input = h('select', { id: id, name: f.id, required: f.required }, [h('option', { value: '', text: '選択してください' })]
          .concat(f.options.map(function (o) { return h('option', { value: o, text: o }); })));
      } else if (f.type === 'radio' || f.type === 'checkbox') {
        input = h('div', { class: 'sk-choices', role: f.type === 'radio' ? 'radiogroup' : 'group' }, f.options.map(function (o, i) {
          return h('label', { class: 'sk-choice' }, [h('input', { type: f.type, name: f.id, value: o, required: f.required && f.type === 'radio' && i === 0 }), ' ' + o]);
        }));
      } else {
        input = h('input', { id: id, name: f.id, type: f.type === 'tel' ? 'tel' : f.type === 'email' ? 'email' : f.type === 'date' ? 'date' : 'text',
                             placeholder: f.placeholder, required: f.required, autocomplete: f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'on' });
      }
      wrap.appendChild(h('div', { class: 'sk-field' }, [
        h('label', { class: 'sk-label', for: id }, [f.label, f.required ? h('span', { class: 'sk-req', text: '必須' }) : h('span', { class: 'sk-opt', text: '任意' })]),
        input,
        f.help ? h('p', { class: 'sk-help', html: f.help.replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; }).replace(/\n/g, '<br>') }) : null
      ]));
    });
    // スパム対策の見えない欄
    wrap.appendChild(h('div', { class: 'sk-hp', 'aria-hidden': 'true' }, [h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' })]));
    return wrap;
  }

  function readForm(form, fields) {
    var v = {};
    fields.forEach(function (f) {
      if (f.type === 'checkbox') {
        v[f.id] = Array.prototype.map.call(form.querySelectorAll('input[name="' + f.id + '"]:checked'), function (i) { return i.value; });
      } else if (f.type === 'radio') {
        var c = form.querySelector('input[name="' + f.id + '"]:checked');
        v[f.id] = c ? c.value : '';
      } else {
        v[f.id] = (form.elements[f.id] || {}).value || '';
      }
    });
    return v;
  }

  // ---------------------------------------------------------------- 予約カレンダー
  function Booking(el) {
    var facility = el.getAttribute('data-calendar');
    var state = { slots: [], fields: [], month: null };
    var today = new Date(); today.setHours(0, 0, 0, 0);
    state.month = new Date(today.getFullYear(), today.getMonth(), 1);
    el.innerHTML = '';
    var note = h('div', { class: 'sk-note' });
    var cal = h('div', { class: 'sk-cal', 'aria-live': 'polite' });
    var panel = h('div', { class: 'sk-panel' });
    el.appendChild(note); el.appendChild(cal); el.appendChild(panel);
    cal.appendChild(h('p', { class: 'sk-loading', text: '予約カレンダーを読み込んでいます…' }));

    Promise.all([get({ action: 'slots', facility: facility }), get({ action: 'form', facility: facility })]).then(function (r) {
      if (!r[0].ok) throw new Error(r[0].error);
      state.slots = r[0].slots; state.fields = r[1].fields || [];
      if (r[0].note) note.appendChild(h('p', { text: r[0].note }));
      var firstOpen = state.slots.filter(function (s) { return s.state === 'open'; })[0];
      if (firstOpen) { var d = new Date(firstOpen.date); state.month = new Date(d.getFullYear(), d.getMonth(), 1); }
      render();
    }).catch(function () {
      cal.innerHTML = '';
      notReady(cal);
    });

    function ymd(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

    function render() {
      cal.innerHTML = '';
      var m = state.month;
      var prev = h('button', { type: 'button', class: 'sk-nav', 'aria-label': '前の月', html: '&lsaquo;', onclick: function () { state.month = new Date(m.getFullYear(), m.getMonth() - 1, 1); render(); } });
      var next = h('button', { type: 'button', class: 'sk-nav', 'aria-label': '次の月', html: '&rsaquo;', onclick: function () { state.month = new Date(m.getFullYear(), m.getMonth() + 1, 1); render(); } });
      cal.appendChild(h('div', { class: 'sk-cal-head' }, [prev, h('div', { class: 'sk-cal-title', text: m.getFullYear() + '年' + (m.getMonth() + 1) + '月' }), next]));
      var grid = h('div', { class: 'sk-grid', role: 'grid' });
      WEEK.forEach(function (w, i) { grid.appendChild(h('div', { class: 'sk-wd sk-wd' + i, text: w })); });
      var first = new Date(m.getFullYear(), m.getMonth(), 1);
      for (var i = 0; i < first.getDay(); i++) grid.appendChild(h('div', { class: 'sk-day sk-empty' }));
      var last = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      for (var d = 1; d <= last; d++) {
        var date = new Date(m.getFullYear(), m.getMonth(), d);
        var key = ymd(date);
        var slots = state.slots.filter(function (s) { return s.date === key; });
        var open = slots.filter(function (s) { return s.state === 'open'; });
        var cls = 'sk-day sk-w' + date.getDay() + (date < today ? ' sk-past' : '') + (slots.length ? ' sk-has' : '') + (open.length ? ' sk-open' : '');
        var mark = !slots.length ? '' : open.length ? '○' : slots.some(function (s) { return s.state === 'full'; }) ? '満' : '−';
        var cell = h(open.length ? 'button' : 'div', { type: open.length ? 'button' : undefined, class: cls }, [
          h('span', { class: 'sk-num', text: String(d) }),
          mark ? h('span', { class: 'sk-mark', text: mark }) : null,
          slots.length ? h('span', { class: 'sk-title', text: slots[0].title }) : null
        ]);
        if (open.length) (function (k) { cell.addEventListener('click', function () { showDay(k); }); })(key);
        grid.appendChild(cell);
      }
      cal.appendChild(grid);
      cal.appendChild(h('p', { class: 'sk-legend', text: '○ 受付中　満 満員　− 受付期間外' }));
    }

    function showDay(key) {
      panel.innerHTML = '';
      var slots = state.slots.filter(function (s) { return s.date === key && s.state === 'open'; });
      var d = new Date(key);
      panel.appendChild(h('h3', { class: 'sk-panel-title', text: (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WEEK[d.getDay()] + '）' }));
      slots.forEach(function (s) {
        panel.appendChild(h('button', { type: 'button', class: 'sk-slot', onclick: function () { showForm(s); } }, [
          h('span', { class: 'sk-slot-time', text: s.time + '〜' }),
          h('span', { class: 'sk-slot-title', text: s.title }),
          h('span', { class: 'sk-slot-remain', text: s.mode === '抽選' ? '抽選' : '残り' + s.remain })
        ]));
      });
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function showForm(slot) {
      panel.innerHTML = '';
      var d = new Date(slot.date);
      panel.appendChild(h('div', { class: 'sk-selected' }, [
        h('strong', { text: '予約日時　' }),
        (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WEEK[d.getDay()] + '）' + slot.time + '　' + slot.title
      ]));
      var msg = h('div', { class: 'sk-result', role: 'alert' });
      var submit = h('button', { type: 'submit', class: 'sk-submit', text: slot.mode === '抽選' ? '申し込む' : '予約する' });
      var form = h('form', { class: 'sk-form', novalidate: true }, [buildFields(state.fields), msg,
        h('div', { class: 'sk-actions' }, [submit, h('button', { type: 'button', class: 'sk-back', text: '戻る', onclick: function () { showDay(slot.date); } })])]);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!form.reportValidity()) return;
        submit.disabled = true; submit.textContent = '送信中…'; msg.textContent = '';
        post({ action: 'book', facility: facility, slotId: slot.id, values: readForm(form, state.fields), website: form.elements.website.value })
          .then(function (r) {
            if (!r.ok) throw new Error(r.error || '送信できませんでした');
            panel.innerHTML = '';
            panel.appendChild(h('div', { class: 'sk-done' }, [h('p', { text: r.message })]));
            slot.remain = slot.remain === null ? null : slot.remain - 1;
          })
          .catch(function (err) {
            msg.textContent = err.message || '送信できませんでした。時間をおいてもう一度お試しください。';
            submit.disabled = false; submit.textContent = slot.mode === '抽選' ? '申し込む' : '予約する';
          });
      });
      panel.appendChild(form);
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ---------------------------------------------------------------- お問い合わせ
  function Contact(el) {
    el.innerHTML = '';
    el.appendChild(h('p', { class: 'sk-loading', text: 'フォームを読み込んでいます…' }));
    get({ action: 'contactForm' }).then(function (r) {
      if (!r.ok || !r.fields.length) throw new Error();
      var fields = r.fields;
      el.innerHTML = '';
      var msg = h('div', { class: 'sk-result', role: 'alert' });
      var agree = h('label', { class: 'sk-agree' }, [h('input', { type: 'checkbox', name: 'agree', required: true }), ' ',
        h('a', { href: (CFG.base || '') + '/privacy-policy/', target: '_blank', text: 'プライバシーポリシー' }), 'をお読みいただき、同意の上、送信してください。']);
      var submit = h('button', { type: 'submit', class: 'sk-submit', text: '送信する' });
      var form = h('form', { class: 'sk-form', novalidate: true }, [
        h('p', { class: 'sk-help', text: '※営業・セールスを目的とした送信はお控えくださいますようお願いいたします。' }),
        buildFields(fields), agree,
        h('p', { class: 'sk-help', text: '確認画面は表示されません。入力内容をよくご確認の上、送信ボタンを押してください。' }),
        msg, h('div', { class: 'sk-actions' }, [submit])]);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!form.reportValidity()) return;
        submit.disabled = true; submit.textContent = '送信中…';
        post({ action: 'contact', values: readForm(form, fields), website: form.elements.website.value }).then(function (r) {
          if (!r.ok) throw new Error(r.error);
          el.innerHTML = '';
          el.appendChild(h('div', { class: 'sk-done' }, [h('p', { text: r.message })]));
        }).catch(function (err) {
          msg.textContent = (err && err.message) || '送信できませんでした。時間をおいてもう一度お試しください。';
          submit.disabled = false; submit.textContent = '送信する';
        });
      });
      el.appendChild(form);
    }).catch(function () {
      el.innerHTML = '';
      el.appendChild(h('p', { class: 'sk-msg', text: 'フォームを読み込めませんでした。お電話（029-219-0007）でお問い合わせください。' }));
    });
  }

  function init() {
    if (!API) {
      document.querySelectorAll('.sk-booking, .sk-contact').forEach(notReady);
      return;
    }
    document.querySelectorAll('.sk-booking').forEach(Booking);
    document.querySelectorAll('.sk-contact').forEach(Contact);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
