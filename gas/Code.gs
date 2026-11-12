/**
 * さくらこども園サイト 管理用 Google Apps Script
 *
 * 1つのスプレッドシートで次のことを行います。
 *   ・お知らせの更新（「お知らせ」シート）→ サイトのビルド時に読み込み
 *   ・子育て支援の予約（「予約枠」「予約」「フォーム項目」シート）
 *   ・お問い合わせフォーム（「お問い合わせ」シート）
 *
 * 初回だけ：メニュー「さくらサイト」→「初期設定（シートを作る）」を実行してください。
 * そのあと「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *   実行ユーザー：自分 ／ アクセスできるユーザー：全員 でデプロイし、URL をサイトの config.json の gasUrl に入れます。
 */

var SHEETS = {
  news: 'お知らせ',
  slots: '予約枠',
  bookings: '予約',
  fields: 'フォーム項目',
  contact: 'お問い合わせ',
  settings: '設定'
};
var FACILITIES = { kids: 'さくらキッズ', land: 'こそだてランド' };
var TZ = 'Asia/Tokyo';

// ------------------------------------------------------------------ メニュー
function onOpen() {
  SpreadsheetApp.getUi().createMenu('さくらサイト')
    .addItem('サイトに今すぐ反映する', 'publishNow')
    .addItem('結果メールを送る（当選・落選）', 'sendResultMails')
    .addSeparator()
    .addItem('初期設定（シートを作る）', 'setup')
    .addToUi();
}

function onEdit(e) {
  // お知らせ・予約枠に ID を自動で付ける
  var sh = e.range.getSheet();
  var name = sh.getName();
  if (name !== SHEETS.news && name !== SHEETS.slots) return;
  var row = e.range.getRow();
  if (row < 2) return;
  var idCell = sh.getRange(row, 1);
  if (!idCell.getValue()) {
    idCell.setValue(Utilities.getUuid().slice(0, 8));
  }
}

// ------------------------------------------------------------------ 設定
function setting_(key, fallback) {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.settings);
  if (!sh) return fallback;
  var vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (vals[i][0] === key) return vals[i][1] === '' ? fallback : vals[i][1];
  }
  return fallback;
}

// ------------------------------------------------------------------ Web API
function doGet(e) {
  var p = e.parameter || {};
  try {
    switch (p.action) {
      case 'news':   return csv_(newsCsv_());
      case 'image':  return json_(newsImage_(p.id));
      case 'slots':  return json_(listSlots_(p.facility));
      case 'form':   return json_(formFields_(p.facility));
      case 'contactForm': return json_(formFields_('contact'));
      default:       return json_({ ok: true, service: 'sakura-site' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (x) {}
  try {
    if (body.website) return json_({ ok: true }); // スパム対策（見えない入力欄に何か入っていたら無視）
    if (!verifyRecaptcha_(body.recaptchaToken)) return json_({ ok: false, error: '送信を確認できませんでした。時間をおいてもう一度お試しください。' });
    if (body.action === 'book') return json_(book_(body));
    if (body.action === 'contact') return json_(contact_(body));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function csv_(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.CSV);
}

function verifyRecaptcha_(token) {
  var secret = setting_('reCAPTCHAシークレットキー', '');
  if (!secret) return true; // 未設定なら確認しない
  if (!token) return false;
  var res = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'post', payload: { secret: secret, response: token }, muteHttpExceptions: true
  });
  var j = JSON.parse(res.getContentText());
  return j.success && (j.score === undefined || j.score >= 0.3);
}

// ------------------------------------------------------------------ お知らせ
function newsRows_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.news);
  var vals = sh.getDataRange().getValues();
  var head = vals[0];
  var rows = [];
  for (var i = 1; i < vals.length; i++) {
    var o = {};
    head.forEach(function (h, j) { o[h] = vals[i][j]; });
    if (o['公開'] === true && o['日付'] && o['タイトル']) rows.push(o);
  }
  return { head: head, rows: rows };
}

function newsCsv_() {
  var d = newsRows_();
  var esc = function (v) {
    if (v instanceof Date) v = Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
    v = String(v === null || v === undefined ? '' : v);
    return '"' + v.replace(/"/g, '""') + '"';
  };
  var lines = [d.head.map(esc).join(',')];
  d.rows.forEach(function (r) {
    lines.push(d.head.map(function (h) { return esc(h === '公開' ? 'TRUE' : r[h]); }).join(','));
  });
  return lines.join('\n');
}

/** 公開中のお知らせに貼られた Google ドライブの画像だけを返す（ビルド用） */
function newsImage_(id) {
  if (!id) return { ok: false };
  var allowed = false;
  newsRows_().rows.forEach(function (r) {
    Object.keys(r).forEach(function (k) {
      if (/^画像/.test(k) && String(r[k]).indexOf(id) >= 0) allowed = true;
    });
  });
  if (!allowed) return { ok: false, error: 'not published' };
  var blob = DriveApp.getFileById(id).getBlob();
  return { ok: true, type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

/** GitHub Actions に「ビルドして」と合図を送る */
function publishNow() {
  var repo = setting_('GitHubリポジトリ', '');
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  var ui = SpreadsheetApp.getUi();
  if (!repo || !token) {
    ui.alert('自動反映の設定がまだです。1時間ごとの自動反映で、そのうちサイトに出ます。');
    return;
  }
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/dispatches', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ event_type: 'sheet-updated' })
  });
  ui.alert(res.getResponseCode() < 300 ? 'サイトの更新を開始しました。2〜3分で反映されます。' : '反映に失敗しました: ' + res.getContentText());
}

// ------------------------------------------------------------------ 予約
function facilityName_(key) {
  if (!FACILITIES[key]) throw new Error('施設の指定が正しくありません');
  return FACILITIES[key];
}

function slotsData_() {
  var ss = SpreadsheetApp.getActive();
  var sv = ss.getSheetByName(SHEETS.slots).getDataRange().getValues();
  var bv = ss.getSheetByName(SHEETS.bookings).getDataRange().getValues();
  var counts = {};
  for (var i = 1; i < bv.length; i++) {
    var st = bv[i][5];
    if (st === 'キャンセル' || st === '落選') continue;
    counts[bv[i][1]] = (counts[bv[i][1]] || 0) + 1;
  }
  var list = [];
  for (var j = 1; j < sv.length; j++) {
    var r = sv[j];
    if (!r[0] || !r[2]) continue;
    var date = r[2] instanceof Date ? r[2] : new Date(r[2]);
    var time = r[3] instanceof Date ? Utilities.formatDate(r[3], TZ, 'HH:mm') : String(r[3] || '10:00');
    var start = new Date(Utilities.formatDate(date, TZ, 'yyyy/MM/dd') + ' ' + time);
    list.push({
      id: String(r[0]), facility: r[1], date: Utilities.formatDate(date, TZ, 'yyyy-MM-dd'), time: time,
      title: r[4], capacity: Number(r[5]) || 0, deadlineMin: Number(r[6]) || 0,
      open: r[7] === true, mode: r[8] || '先着', booked: counts[String(r[0])] || 0, start: start
    });
  }
  return list;
}

function listSlots_(facility) {
  var name = facilityName_(facility);
  var now = new Date();
  var out = slotsData_().filter(function (s) { return s.facility === name && s.start > new Date(now.getTime() - 86400000); })
    .map(function (s) {
      var deadline = new Date(s.start.getTime() - s.deadlineMin * 60000);
      var remain = s.mode === '抽選' ? null : Math.max(0, s.capacity - s.booked);
      var state = !s.open || now > deadline ? 'closed' : (remain === 0 ? 'full' : 'open');
      return { id: s.id, date: s.date, time: s.time, title: s.title, mode: s.mode, remain: remain, capacity: s.capacity, state: state };
    });
  return { ok: true, facility: name, slots: out, note: setting_(name + 'の案内', '') };
}

function formFields_(facility) {
  var name = facility === 'contact' ? 'お問い合わせ' : facilityName_(facility);
  var v = SpreadsheetApp.getActive().getSheetByName(SHEETS.fields).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < v.length; i++) {
    if (v[i][0] !== name || v[i][1] === '') continue;
    out.push({ id: String(v[i][1]), label: v[i][2], type: v[i][3] || 'text',
               options: String(v[i][4] || '').split(/[,、]/).filter(String), required: v[i][5] === true,
               help: v[i][6] || '', placeholder: v[i][7] || '', order: Number(v[i][8]) || i });
  }
  out.sort(function (a, b) { return a.order - b.order; });
  return { ok: true, fields: out };
}

function validate_(fields, values) {
  var errors = [];
  fields.forEach(function (f) {
    var v = values[f.id];
    var empty = v === undefined || v === null || String(v).trim() === '' || (Array.isArray(v) && !v.length);
    if (f.required && empty) errors.push(f.label + 'を入力してください');
    if (!empty && f.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) errors.push('メールアドレスの形式が正しくありません');
  });
  return errors;
}

function book_(b) {
  var facility = facilityName_(b.facility);
  var fields = formFields_(b.facility).fields;
  var errors = validate_(fields, b.values || {});
  if (errors.length) return { ok: false, error: errors.join('\n') };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var slot = slotsData_().filter(function (s) { return s.id === String(b.slotId) && s.facility === facility; })[0];
    if (!slot) return { ok: false, error: '選んだ日の予約枠が見つかりません。' };
    var now = new Date();
    var deadline = new Date(slot.start.getTime() - slot.deadlineMin * 60000);
    if (!slot.open || now > deadline) return { ok: false, error: 'この日の受付は終了しています。' };
    if (slot.mode !== '抽選' && slot.booked >= slot.capacity) return { ok: false, error: '申し訳ありません。この日は満員になりました。' };

    var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.bookings);
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    // フォーム項目が増えていたら列を追加
    fields.forEach(function (f) {
      if (head.indexOf(f.label) < 0) { head.push(f.label); sh.getRange(1, head.length).setValue(f.label); }
    });
    var row = head.map(function (h) {
      switch (h) {
        case '受付日時': return now;
        case '枠ID': return slot.id;
        case '施設': return facility;
        case '日付': return slot.date + ' ' + slot.time;
        case 'イベント': return slot.title;
        case '状態': return slot.mode === '抽選' ? '申込' : '受付';
        default:
          var f = fields.filter(function (x) { return x.label === h; })[0];
          if (!f) return '';
          var v = (b.values || {})[f.id];
          return Array.isArray(v) ? v.join('、') : (v || '');
      }
    });
    sh.appendRow(row);
  } finally {
    lock.releaseLock();
  }
  notifyBooking_(facility, slot, fields, b.values || {});
  return { ok: true, mode: slot.mode, message: slot.mode === '抽選' ? setting_('抽選申込の完了メッセージ', 'お申し込みを受け付けました。結果はメールでお知らせします。') : setting_('予約完了メッセージ', 'ご予約を受け付けました。確認メールをお送りしました。') };
}

function detailText_(fields, values) {
  return fields.map(function (f) {
    var v = values[f.id];
    return '■' + f.label + '\n' + (Array.isArray(v) ? v.join('、') : (v || '')) + '\n';
  }).join('\n');
}

function notifyBooking_(facility, slot, fields, values) {
  var staff = setting_(facility + 'の通知先メール', '');
  var from = setting_('メールの差出人名', 'さくらこども園');
  var when = slot.date.replace(/-/g, '/') + ' ' + slot.time + '　' + slot.title;
  var detail = detailText_(fields, values);
  var emailField = fields.filter(function (f) { return f.type === 'email'; })[0];
  var to = emailField ? values[emailField.id] : '';
  var isLottery = slot.mode === '抽選';
  if (to) {
    var subject = '【' + facility + '】' + (isLottery ? 'お申し込みを受け付けました' : 'ご予約を受け付けました');
    var bodyText = (values.name || values.parentname || '') + ' 様\n\n' + facility + 'への' + (isLottery ? 'お申し込み' : 'ご予約') + 'ありがとうございます。\n'
      + (isLottery ? '抽選の結果は、後日メールでお知らせします。\n' : '') + '\n◆日時\n' + when + '\n\n' + detail
      + '\n' + setting_('予約メールの署名', '社会福祉法人 秀桜会 さくらこども園\nTEL 029-219-0007');
    MailApp.sendEmail({ to: to, subject: subject, body: bodyText, name: from, replyTo: staff || undefined });
  }
  if (staff) {
    MailApp.sendEmail({ to: staff, subject: '【' + facility + '】新しい' + (isLottery ? '申込' : '予約') + '：' + when, body: when + '\n\n' + detail, name: 'サイト予約通知', replyTo: to || undefined });
  }
}

// ------------------------------------------------------------------ 結果メール（当選・落選）
var RESULT_MAIL_DEFAULTS = [
  ['当選メールの件名', '【{施設}】ご参加が決まりました（{日時}）', '{施設} {日時} {イベント} {お名前} が使えます'],
  ['当選メールの本文',
   '{お名前} 様\n\nこのたびは{施設}にお申し込みいただき、ありがとうございます。\n抽選の結果、下記の日程でご参加いただけることになりました。\n\n◆日時\n{日時}\n◆内容\n{イベント}\n\n当日は、お気をつけてお越しください。\nご都合が悪くなった場合は、お早めにお電話でご連絡をお願いいたします。',
   '{施設} {日時} {イベント} {お名前} が使えます。最後に「予約メールの署名」が付きます'],
  ['落選メールの件名', '【{施設}】抽選結果のお知らせ（{日時}）', ''],
  ['落選メールの本文',
   '{お名前} 様\n\nこのたびは{施設}にお申し込みいただき、ありがとうございます。\n申し訳ございませんが、抽選の結果、下記の日程はご希望に添えませんでした。\n\n◆日時\n{日時}\n◆内容\n{イベント}\n\nキャンセルが出た場合は、Instagramでお知らせします。\nまたのお申し込みをお待ちしております。',
   '最後に「予約メールの署名」が付きます']
];

/** 「設定」タブに結果メールの文面がなければ追加する */
function ensureResultMailSettings_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.settings);
  var keys = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues().map(function (r) { return r[0]; });
  RESULT_MAIL_DEFAULTS.forEach(function (row) {
    if (keys.indexOf(row[0]) < 0) {
      sh.appendRow(row);
      sh.getRange(sh.getLastRow(), 2, 1, 2).setWrap(true);
    }
  });
}

function fillTemplate_(text, vars) {
  return String(text || '').replace(/\{(施設|日時|イベント|お名前)\}/g, function (_, k) { return vars[k] || ''; });
}

function prettyWhen_(s) {
  // "2026-11-18 10:00" → "11月18日（水）10:00"（セルが日付として読み込まれていても同じ形にする）
  if (s instanceof Date) s = Utilities.formatDate(s, TZ, 'yyyy-MM-dd HH:mm');
  var m = String(s).match(/(\d{4})-(\d{1,2})-(\d{1,2})\s*(\d{1,2}:\d{2})?/);
  if (!m) return String(s);
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  var w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return Number(m[2]) + '月' + Number(m[3]) + '日（' + w + '）' + (m[4] || '');
}

/** 「予約」タブで状態が「当選」「落選」で、まだメールを送っていない人にまとめて送る */
function sendResultMails() {
  var ui = SpreadsheetApp.getUi();
  ensureResultMailSettings_();
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.bookings);
  var lastCol = sh.getLastColumn();
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var sentCol = head.indexOf('メール送信日時');
  if (sentCol < 0) {
    sentCol = head.length;
    sh.getRange(1, sentCol + 1).setValue('メール送信日時').setFontWeight('bold').setBackground('#fde7d6');
    head.push('メール送信日時');
  }
  var lastRow = sh.getLastRow();
  if (lastRow < 2) { ui.alert('予約がまだありません。'); return; }
  var rows = sh.getRange(2, 1, lastRow - 1, head.length).getValues();
  var col = function (name) { return head.indexOf(name); };
  // メールアドレスの列（フォーム項目で種類が email のもの）
  var fv = SpreadsheetApp.getActive().getSheetByName(SHEETS.fields).getDataRange().getValues();
  var emailLabels = fv.filter(function (r) { return r[3] === 'email'; }).map(function (r) { return r[2]; });

  var targets = [];
  rows.forEach(function (r, i) {
    var state = r[col('状態')];
    if ((state !== '当選' && state !== '落選') || r[sentCol]) return;
    var to = '';
    emailLabels.forEach(function (l) { if (!to && col(l) >= 0 && r[col(l)]) to = String(r[col(l)]).trim(); });
    targets.push({ row: i + 2, state: state, to: to, r: r });
  });
  var noMail = targets.filter(function (t) { return !t.to; });
  targets = targets.filter(function (t) { return t.to; });
  if (!targets.length) {
    ui.alert('送る相手がいません。\n「状態」が当選・落選で、「メール送信日時」が空の行が対象です。' + (noMail.length ? '\n（メールアドレスが空の行が ' + noMail.length + ' 件あります）' : ''));
    return;
  }
  var win = targets.filter(function (t) { return t.state === '当選'; }).length;
  var ok = ui.alert('結果メールを送ります',
    '当選 ' + win + ' 件、落選 ' + (targets.length - win) + ' 件、合計 ' + targets.length + ' 件に送ります。よろしいですか？' +
    (noMail.length ? '\n（メールアドレスが空の ' + noMail.length + ' 件は送りません）' : '') +
    '\n\n残りの送信可能数（今日）: ' + MailApp.getRemainingDailyQuota(), ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;

  var from = setting_('メールの差出人名', 'さくらこども園');
  var sign = setting_('予約メールの署名', '');
  var sent = 0, failed = [];
  targets.forEach(function (t) {
    var r = t.r;
    var facility = r[col('施設')];
    var name = (col('保護者の氏名') >= 0 && r[col('保護者の氏名')]) || (col('お子さまのお名前') >= 0 && r[col('お子さまのお名前')]) || '';
    var vars = { '施設': facility, '日時': prettyWhen_(r[col('日付')]), 'イベント': r[col('イベント')], 'お名前': name };
    var key = t.state === '当選' ? '当選' : '落選';
    var subject = fillTemplate_(setting_(key + 'メールの件名', ''), vars);
    var body = fillTemplate_(setting_(key + 'メールの本文', ''), vars) + (sign ? '\n\n' + sign : '');
    var replyTo = setting_(facility + 'の通知先メール', '');
    try {
      MailApp.sendEmail({ to: t.to, subject: subject, body: body, name: from, replyTo: replyTo || undefined });
      sh.getRange(t.row, sentCol + 1).setValue(new Date());
      sent++;
    } catch (e) {
      failed.push(t.row + '行目（' + e.message + '）');
    }
  });
  ui.alert(sent + ' 件のメールを送りました。' + (failed.length ? '\n送れなかったもの:\n' + failed.join('\n') : ''));
}

// ------------------------------------------------------------------ お問い合わせ
function contact_(b) {
  var fields = formFields_('contact').fields;
  var values = b.values || {};
  var errors = validate_(fields, values);
  if (errors.length) return { ok: false, error: errors.join('\n') };
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.contact);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  fields.forEach(function (f) {
    if (head.indexOf(f.label) < 0) { head.push(f.label); sh.getRange(1, head.length).setValue(f.label); }
  });
  sh.appendRow(head.map(function (h) {
    if (h === '受信日時') return new Date();
    if (h === '対応状況') return '未対応';
    var f = fields.filter(function (x) { return x.label === h; })[0];
    var v = f ? values[f.id] : '';
    return Array.isArray(v) ? v.join('、') : (v || '');
  }));
  var staff = setting_('お問い合わせの通知先メール', '');
  var detail = detailText_(fields, values);
  var emailField = fields.filter(function (f) { return f.type === 'email'; })[0];
  var to = emailField ? values[emailField.id] : '';
  if (staff) MailApp.sendEmail({ to: staff, subject: '【お問い合わせ】' + (values['your-subject'] || ''), body: detail, name: 'サイトお問い合わせ', replyTo: to || undefined });
  if (to) MailApp.sendEmail({ to: to, subject: '【さくらこども園】お問い合わせを受け付けました', name: setting_('メールの差出人名', 'さくらこども園'),
    body: 'お問い合わせありがとうございます。内容を確認のうえ、担当者よりご連絡いたします。\n\n' + detail + '\n' + setting_('予約メールの署名', ''), replyTo: staff || undefined });
  return { ok: true, message: setting_('お問い合わせ完了メッセージ', 'お問い合わせを受け付けました。確認メールをお送りしました。') };
}

// ------------------------------------------------------------------ 初期設定
function setup() {
  var ss = SpreadsheetApp.getActive();
  function sheet(name, head, widths) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#fde7d6');
      sh.setFrozenRows(1);
      (widths || []).forEach(function (w, i) { if (w) sh.setColumnWidth(i + 1, w); });
    }
    return sh;
  }
  // お知らせ
  var news = sheet(SHEETS.news, ['ID', '公開', '日付', 'タイトル', 'カテゴリ', '本文', '画像1', '画像2', '画像3', '画像4', '画像5', '画像6', 'メモ'],
                   [80, 50, 110, 260, 120, 420, 160, 160, 160, 160, 160, 160, 160]);
  news.getRange('B2:B1000').insertCheckboxes();
  news.getRange('C2:C1000').setNumberFormat('yyyy/mm/dd');
  news.getRange('E2:E1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['さくらこども園', 'さくらランド', 'カラフル'], true).build());
  news.getRange('F2:F1000').setWrap(true);

  // 予約枠
  var slots = sheet(SHEETS.slots, ['ID', '施設', '日付', '開始時刻', 'イベント名', '定員', '締切（開始の何分前）', '受付中', '受付方式', '予約数'],
                    [80, 120, 110, 80, 300, 60, 140, 70, 90, 70]);
  slots.getRange('B2:B1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['さくらキッズ', 'こそだてランド'], true).build());
  slots.getRange('C2:C1000').setNumberFormat('yyyy/mm/dd(ddd)');
  slots.getRange('D2:D1000').setNumberFormat('@');
  slots.getRange('H2:H1000').insertCheckboxes();
  slots.getRange('I2:I1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['先着', '抽選'], true).build());
  slots.getRange('J2').setFormula('=MAP(A2:A,LAMBDA(id,IF(id="","",COUNTIFS(\'予約\'!B:B,id,\'予約\'!F:F,"<>キャンセル",\'予約\'!F:F,"<>落選"))))');

  // 予約・お問い合わせ（受け付けた内容が入る）
  var bk = sheet(SHEETS.bookings, ['受付日時', '枠ID', '施設', '日付', 'イベント', '状態'], [140, 80, 110, 130, 260, 80]);
  bk.getRange('F2:F5000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['受付', '申込', '当選', '落選', 'キャンセル'], true).build());
  var ct = sheet(SHEETS.contact, ['受信日時', '対応状況'], [140, 90]);
  ct.getRange('B2:B5000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['未対応', '対応中', '完了'], true).build());

  // フォーム項目（元のサイトと同じ項目で作成）
  var fs = sheet(SHEETS.fields, ['フォーム', '項目ID', '表示名', '種類', '選択肢（カンマ区切り）', '必須', '説明', '入力例', '並び順'],
                 [120, 120, 160, 90, 200, 50, 320, 200, 60]);
  if (fs.getLastRow() < 2) {
    var kids = [
      ['name', 'お子さまのお名前', 'text', '', true, '', '', 1],
      ['age', '年齢', 'text', '', true, '年齢にあった食事(離乳食)を用意するのに必要となります。', 'お子さまの年齢を教えてください。', 2],
      ['email', 'メール', 'email', '', true, '', '', 3],
      ['phone', '電話', 'tel', '', true, '', '', 4],
      ['repeats', '利用回数', 'radio', '新規利用,２回目以降', true, '以前、利用した事がある人は、2回目以降をチェックして下さい。', '', 5],
      ['parentname', '保護者の氏名', 'text', '', false, 'ご新規の方はご記入ください。', '', 6],
      ['address', '住所', 'text', '', false, 'ご新規の方はご記入ください。', '東茨城郡茨城町〇〇〇〇', 7],
      ['phonenumber', '電話番号', 'tel', '', false, 'ご新規の方はご記入ください。', '', 8],
      ['childbirthday', 'お子さまのお誕生日', 'text', '', false, 'ご新規の方はご記入ください。', '', 9],
      ['lunch', 'ランチ', 'radio', 'はい,いいえ', true, '大人 300円 ／ 子ども 200円', '', 10],
      ['lunchdetails', 'ランチ利用人数', 'text', '', false, '1.ランチ利用人数 大人 ◯名 子ども ◯名\nランチを利用されない方は、なしとご回答下さい。', '利用人数について、教えてください。', 11],
      ['remarks', '備考', 'textarea', '', false, '他、質問事項等あれば、ご記入下さい。', '', 12]
    ];
    var land = [
      ['name', 'お子さまのお名前', 'text', '', true, '', '', 1],
      ['email', 'メール', 'email', '', true, '', '', 2],
      ['phone', '電話', 'tel', '', true, '', '', 3],
      ['repeats', '利用回数', 'radio', '新規,２回目以降', true, '以前、利用した事がある人は、2回目以降をチェックして下さい。', '', 4],
      ['parentname', '保護者の氏名', 'text', '', false, 'ご新規の方はご記入ください。', '', 5],
      ['address', '住所', 'text', '', false, 'ご新規の方はご記入ください。', '', 6],
      ['childbirthday', 'お子さまのお誕生日', 'text', '', false, 'ご新規の方はご記入ください。', '', 7],
      ['remarks', '備考', 'textarea', '', false, '他、質問事項等あれば、ご記入下さい。', '', 8]
    ];
    var contact = [
      ['your-name', 'お名前（漢字）', 'text', '', true, '', '例：茨城 太郎', 1],
      ['your-kana', 'お名前（ふりがな）', 'text', '', true, '', '例：いばらき たろう', 2],
      ['your-email', 'メールアドレス', 'email', '', true, '', '例：sample@example.com', 3],
      ['your-tel', '電話番号（ハイフンなし）', 'tel', '', true, '', '例：0291234567', 4],
      ['your-child-age', 'お子様の年齢', 'text', '', false, '', '例：3', 5],
      ['your-address', 'ご住所', 'text', '', true, '', '例：水戸市笠原町123-4', 6],
      ['your-subject', 'お問い合わせの種類', 'select', '園の見学について,入園の流れについて,その他', true, '', '', 7],
      ['your-message', 'お問い合わせ内容', 'textarea', '', false, '', '例：園の見学を希望しています。', 8]
    ];
    var rows = [];
    kids.forEach(function (r) { rows.push(['さくらキッズ'].concat(r)); });
    land.forEach(function (r) { rows.push(['こそだてランド'].concat(r)); });
    contact.forEach(function (r) { rows.push(['お問い合わせ'].concat(r)); });
    fs.getRange(2, 1, rows.length, 9).setValues(rows);
    fs.getRange(2, 6, rows.length, 1).insertCheckboxes();
    fs.getRange(2, 6, rows.length, 1).setValues(rows.map(function (r) { return [r[5]]; }));
    fs.getRange('D2:D1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['text', 'textarea', 'email', 'tel', 'radio', 'checkbox', 'select', 'date'], true).build());
  }

  // 設定
  var st = sheet(SHEETS.settings, ['項目', '値', '説明'], [220, 320, 400]);
  if (st.getLastRow() < 2) {
    st.getRange(2, 1, 11, 3).setValues([
      ['さくらキッズの通知先メール', 'sakurakids@sakura-ibaraki.jp', '予約が入ったときにお知らせが届くアドレス'],
      ['こそだてランドの通知先メール', 'kosodateland@sakura-ibaraki.jp', '予約が入ったときにお知らせが届くアドレス'],
      ['お問い合わせの通知先メール', 'info@sakura-ibaraki.jp', 'お問い合わせが届くアドレス'],
      ['メールの差出人名', 'さくらこども園', '予約した人に届くメールの差出人名'],
      ['予約メールの署名', '社会福祉法人 秀桜会 さくらこども園\nTEL 029-219-0007（平日9:00〜17:00）', 'メールの最後に付く文'],
      ['予約完了メッセージ', 'ご予約を受け付けました。確認メールをお送りしました。', '先着の予約が完了したときの表示'],
      ['抽選申込の完了メッセージ', 'お申し込みを受け付けました。26日頃に来園日をメールでお知らせします。', '抽選の申込が完了したときの表示'],
      ['お問い合わせ完了メッセージ', 'お問い合わせを受け付けました。確認メールをお送りしました。', ''],
      ['さくらキッズの案内', '', 'カレンダーの上に表示する文（空欄なら表示しない）'],
      ['こそだてランドの案内', '', 'カレンダーの上に表示する文（空欄なら表示しない）'],
      ['GitHubリポジトリ', '', '「サイトに今すぐ反映する」を使う場合だけ（例: owner/sakura-site）']
    ]);
    st.getRange('B2:C20').setWrap(true);
  }
  seedSlots_();
  var def = ss.getSheetByName('シート1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
  SpreadsheetApp.getUi().alert('初期設定が終わりました。');
}

/** 移行時点の11月分の予約枠（Booking Package から書き写し。受付は停止のまま） */
function seedSlots_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.slots);
  if (sh.getRange('A2').getValue() !== '') return; // チェックボックスがあると getLastRow は使えないため
  var K ='さくらキッズ', L = 'こそだてランド';
  var rows = [
    [K, '2026/11/12', 'トトロの足形アート', 50], [K, '2026/11/16', 'ベビーよちよち秋さんぽ♪', 50],
    [K, '2026/11/18', 'スイートポテト作り(￥200)', 50], [K, '2026/11/19', 'クリスマスリース作り(材料費￥300)', 50],
    [K, '2026/11/25', '11月生まれの誕生会＆オーナメント作り', 50], [K, '2026/11/26', 'クリスマスリース作り(材料費￥300)', 50],
    [K, '2026/11/30', 'ベビー手作りおもちゃ作り(コロコロ絵合わせ￥150)', 50],
    [L, '2026/11/12', 'ベビーデー　くだものれっしゃあそび', 30], [L, '2026/11/13', 'ベビーデー　くだものれっしゃあそび', 30],
    [L, '2026/11/16', 'キャンバスファーストアート　￥200', 30], [L, '2026/11/17', 'キャンバスファーストアート　￥200', 30],
    [L, '2026/11/19', 'キャンバスファーストアート　￥200', 30], [L, '2026/11/20', 'キャンバスファーストアート', 30],
    [L, '2026/11/24', 'クリスマスタペストリー　￥200', 30], [L, '2026/11/26', 'クリスマスタペストリー　￥200', 30],
    [L, '2026/11/27', 'クリスマスタペストリー　￥200', 30], [L, '2026/11/30', 'クリスマスタペストリー　￥200', 30]
  ];
  var vals = rows.map(function (r) {
    return [Utilities.getUuid().slice(0, 8), r[0], new Date(r[1]), '10:00', r[2], r[3], 120, false, '先着'];
  });
  sh.getRange(2, 1, vals.length, 9).setValues(vals);
}
