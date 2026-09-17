/**
 * ENFit PEG AI発注アシスト v3 — シートアクセス層
 * ------------------------------------------------------------------
 * 既存の在庫シート（A:ID / B:規格名 / C:… / D:従来定数 / E:現在在庫）には
 * 列を足しません。増えるのは以下の5シートだけです。
 *
 *   運用設定   … 発注サイクル・患者数・棚卸周期などの全体設定
 *   品目設定   … 商品ごとの消費ペース・リードタイム・患者数連動
 *   患者名簿   … モバカルから出したCSVを貼るシート
 *   発注ログ   … 確定のたびに追記（監査・学習の元データ）
 *   棚卸ログ   … 月1回の棚卸結果と理論在庫との差異
 * ------------------------------------------------------------------
 */

var CFG = {
  STOCK_SHEET_NAME: '',        // '' なら「システム用シート以外の先頭シート」を自動選択
  SETTINGS_SHEET: '運用設定',
  ITEMS_SHEET: '品目設定',
  PARTIES_SHEET: '発注先',
  PATIENTS_SHEET: '患者名簿',
  ORDER_LOG_SHEET: '発注ログ',
  STOCKTAKE_LOG_SHEET: '棚卸ログ',

  HEADER_ROWS: 1,
  COL_ID: 1, COL_NAME: 2, COL_FIXED: 4, COL_STOCK: 5,

  LOG_MAX_READ: 5000,
  RESUBMIT_GUARD_MIN: 10,      // 直近この分数以内の再確定は確認を求める
  MIN_SAMPLES_TO_APPLY: 3,     // 推奨目標の自動反映に必要な学習回数

  PROP_LAST_ORDER: 'LAST_ORDER_DATE',
  PROP_LAST_STOCKTAKE: 'LAST_STOCKTAKE_DATE'
};

/** 発注サイクルのプリセット（運用設定シートで選ぶ） */
var CYCLE_PRESETS = { '週2回': 3.5, '週1回': 7, '隔週': 14 };
var DOW_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

/** 運用設定シートの初期値。キーが無ければ自動で追記されます */
var SETTINGS_DEFAULTS = [
  ['発注サイクル', '週2回', '週2回 / 週1回 / 隔週 / カスタム'],
  ['発注曜日', '月,木', '曜日を決めているならここに（例: 月,木）。空欄なら平均間隔で計算します'],
  ['カスタム間隔日数', 3.5, '発注サイクルが「カスタム」のときに使う日数'],
  ['既定リードタイム日数', 2, '発注してから届くまでの日数。品目ごとに品目設定シートで上書きできます'],
  ['既定安全日数', 7, '欠品しないための余裕。品目設定シートの「推奨安全日数」も参考にしてください'],
  ['患者数の取得元', '手入力', '手入力 / 患者名簿'],
  ['対象患者数(手入力)', 20, '「患者数の取得元」が手入力のときに使う人数'],
  ['基準患者数', 20, '【重要】「今の患者数」ではなく「その週消費ペースが成り立っていたときの患者数」。分からなければ対象患者数と同じ値にしてください'],
  ['患者数の割当', '全体', '全体 / 資材IDごと（患者名簿のC列に使用資材IDを書いている場合）'],
  ['在籍とみなす状態', '', '患者名簿のB列がこの語を含む行だけ数えます。空欄なら除外条件だけで判定'],
  ['除外する状態', '中止,退院,死亡,終了', '患者名簿のB列がこの語を含む行は数えません'],
  ['棚卸周期(日)', 30, '月1回運用なら30'],
  ['前回発注分は入荷済みとみなす', true, 'FALSEにすると毎回、入荷確認のチェックが外れた状態になります'],
  ['施設名', '医療法人真成会', '発注書の差出人として印刷されます'],
  ['部署名', '', '例: 看護部 / 物品管理'],
  ['施設住所', '', '発注書に印刷されます'],
  ['施設TEL', '', '発注書に印刷されます'],
  ['施設FAX', '', '発注書とFAX送付状に印刷されます'],
  ['発注担当者名', '', '空欄なら発注書には印刷されません'],
  ['FAX送付状をつける', true, 'FAXで送るとき、1枚目に送付状を付けます'],
  ['発注書に金額を印刷', true, 'FALSEにすると単価・金額の列を省きます'],
  ['発注書レイアウト', '取引先様式', '取引先様式（2段組み・現行の紙に合わせた形）／ 標準'],
  ['期限警告日数', 60, '使用期限まで何日を切ったら警告を出すか。品目ごとに上書きできます'],
  ['定数の想定カバー週数', 2, 'メニュー「従来定数から初期化」で使います。従来の定数が何週間ぶんの在庫だったか']
];

var ITEM_HEADERS = [
  '商品ID', '規格名', '週消費ペース', '患者数連動', 'リードタイム日数', '安全日数',
  '学習回数', '最終学習日', '手動固定', '目標在庫(自動)', '推奨安全日数(自動)',
  '直近実績ペース', '対象患者数(自動)', 'メモ',
  // ↓ v3.1 で追加（既存の列位置は変えていません）
  '発注先', '商品コード', '入数', '発注単位', '単価',
  // ↓ v3.2 で追加
  '商品ID(取引先)', '販売元', '規格', '使用期限', '期限警告日数'
];
var ITEM_COL = {
  PARTY: 15, CODE: 16, PACK_SIZE: 17, PACK_UNIT: 18, PRICE: 19,
  VENDOR_ID: 20, MAKER: 21, SPEC: 22, EXPIRY: 23, EXPIRY_WARN: 24
};

var PARTY_HEADERS = ['発注先名', '担当者', 'TEL', 'FAX', 'メール', '住所', '敬称', '備考'];

var PATIENT_HEADERS = ['患者ID/氏名', '状態', '使用資材ID(カンマ区切り)', '備考'];
var ORDER_LOG_HEADERS = [
  '確定日時', '担当者', 'サイクル', '経過日数', '商品ID', '規格名',
  '前回実測在庫', '入荷見込', '今回実測在庫', 'AI予測在庫', '目標在庫', '発注数',
  '推定消費量', '実績週ペース', '学習後ペース', '患者数', '備考',
  // ↓ v3.1 で追加
  '発注書番号', '発注先', '発注単位数', '金額'
];
var STOCKTAKE_LOG_HEADERS = [
  '棚卸日', '担当者', '商品ID', '規格名', '理論在庫', '実棚卸数', '差異', '差異率',
  '前回基準日', '経過日数', '患者数', '実績週ペース', '学習後ペース', '備考',
  // ↓ v3.2 で追加
  '使用期限'
];

/** 初期投入する消費ペース（v1のaiConfigをそのまま移植） */
var SEED_RATES = {
  316: 1.5, 315: 1.5, 305: 0.8, 304: 0.8, 480: 0.7, 308: 0.7, 309: 0.7, 314: 0.7,
  303: 0.4, 311: 0.4, 310: 0.4, 317: 0.4, 313: 0.4,
  324: 0.25, 456: 0.25, 331: 0.25, 407: 0.25, 307: 0.25, 522: 0.25, 523: 0.25
};

/* ==================================================================
   日付ユーティリティ
   ================================================================== */
function dayIndex_(date, tz) {
  var p = Utilities.formatDate(date, tz, 'yyyy-MM-dd').split('-');
  return Math.floor(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000);
}
function diffDays_(from, to, tz) {
  if (!from || !to) return 0;
  return Math.max(0, dayIndex_(to, tz) - dayIndex_(from, tz));
}
function dowOf_(date, tz) { return Number(Utilities.formatDate(date, tz, 'u')) % 7; } // u: 1=月…7=日 → 0=日
function fmtDate_(d, tz) { return d ? Utilities.formatDate(d, tz, 'M/d(E)') : ''; }
function fmtDateTime_(d, tz) { return d ? Utilities.formatDate(d, tz, 'yyyy/MM/dd HH:mm') : ''; }

function currentUser_() {
  try { return Session.getActiveUser().getEmail() || '(不明)'; } catch (e) { return '(不明)'; }
}

/* ==================================================================
   シートの用意
   ================================================================== */
function getStockSheet_(ss) {
  var system = [CFG.SETTINGS_SHEET, CFG.ITEMS_SHEET, CFG.PARTIES_SHEET, CFG.PATIENTS_SHEET,
                CFG.ORDER_LOG_SHEET, CFG.STOCKTAKE_LOG_SHEET, 'AI設定'];
  if (CFG.STOCK_SHEET_NAME) {
    var s = ss.getSheetByName(CFG.STOCK_SHEET_NAME);
    if (!s) throw new Error('在庫シート「' + CFG.STOCK_SHEET_NAME + '」が見つかりません。');
    return s;
  }
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (system.indexOf(sheets[i].getName()) < 0) return sheets[i];
  }
  throw new Error('在庫シートが見つかりません。');
}

/** 見出し行を用意する。既存シートの列が足りなければ足すだけで、データは壊しません */
function ensureHeader_(ss, name, headers, headerColor) {
  var sh = ss.getSheetByName(name);
  var created = false;
  if (!sh) { sh = ss.insertSheet(name); created = true; }
  if (sh.getMaxColumns() < headers.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  }
  var cur = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  var needs = created;
  for (var i = 0; i < headers.length; i++) {
    if (String(cur[i]).trim() !== headers[i]) { needs = true; break; }
  }
  if (needs) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground(headerColor);
    sh.setFrozenRows(1);
  }
  return { sheet: sh, created: created };
}

function ensureSheets_(ss) {
  var settings = ensureHeader_(ss, CFG.SETTINGS_SHEET, ['項目', '設定値', '説明'], '#fff2cc');
  var items    = ensureHeader_(ss, CFG.ITEMS_SHEET, ITEM_HEADERS, '#e8f0fe');
  var parties  = ensureHeader_(ss, CFG.PARTIES_SHEET, PARTY_HEADERS, '#fef7e0');
  var patients = ensureHeader_(ss, CFG.PATIENTS_SHEET, PATIENT_HEADERS, '#fce8e6');
  var olog     = ensureHeader_(ss, CFG.ORDER_LOG_SHEET, ORDER_LOG_HEADERS, '#e6f4ea');
  var slog     = ensureHeader_(ss, CFG.STOCKTAKE_LOG_SHEET, STOCKTAKE_LOG_HEADERS, '#f3e8fd');

  if (settings.created) {
    settings.sheet.getRange(2, 1, SETTINGS_DEFAULTS.length, 3).setValues(SETTINGS_DEFAULTS);
    settings.sheet.setColumnWidth(1, 200);
    settings.sheet.setColumnWidth(2, 130);
    settings.sheet.setColumnWidth(3, 460);
  }
  if (items.created) {
    items.sheet.setColumnWidth(2, 220);
    items.sheet.getRange(1, 10, 1, 4).setBackground('#f1f3f4')
      .setNote('この4列はシステムが自動更新します（手入力しても上書きされます）');
    items.sheet.getRange(1, ITEM_COL.PARTY).setNote(
      '「発注先」シートに書いた発注先名と同じ文字列を入れてください。\n' +
      '空欄の品目は発注書では「発注先未設定」としてまとめられます。');
    items.sheet.getRange(1, ITEM_COL.PACK_SIZE).setNote(
      '1箱（1ケース）に何本入っているか。ばら売りなら 1 または空欄。\n' +
      '例: 10 と入れると「3本必要 → 1箱(10本)」と発注書に出ます。');
    items.sheet.getRange(1, ITEM_COL.PRICE).setNote('発注単位あたりの単価。入数10なら「1箱の値段」を入れてください。');
    items.sheet.getRange(1, ITEM_COL.VENDOR_ID).setNote('取引先（琉球光和さんなど）側の商品ID。発注書の数量欄の下に印刷されます。');
    items.sheet.getRange(1, ITEM_COL.MAKER).setNote('販売元メーカー名。発注書の商品コード欄の下に印刷されます。');
    items.sheet.getRange(1, ITEM_COL.SPEC).setNote('規格。空欄なら在庫シートの規格名をそのまま使います。');
    items.sheet.getRange(1, ITEM_COL.EXPIRY).setNote(
      '次に使うもの（棚の手前）の使用期限。棚卸のときにアプリから入力すると自動で更新されます。');
  }
  if (parties.created) {
    parties.sheet.setColumnWidth(1, 200);
    parties.sheet.setColumnWidth(6, 260);
    parties.sheet.getRange(2, 1, 5, PARTY_HEADERS.length).setValues([
      ['（ここに発注先を1行ずつ書いてください）', '', '', '', '', '', '御中', '敬称は「御中」か「様」'],
      ['', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', '']
    ]);
  }
  if (patients.created) {
    patients.sheet.setColumnWidth(1, 180);
    patients.sheet.setColumnWidth(3, 240);
    patients.sheet.getRange(2, 1).setNote(
      'モバカルから出したCSV/Excelの内容をここに貼り付けてください。\n' +
      'A列に患者ID（または氏名）、B列に状態、C列に使用している資材IDをカンマ区切りで。\n' +
      'C列は空欄でも構いません（その場合は全体の患者数だけを使います）。');
  }
  return {
    settings: settings.sheet, items: items.sheet, parties: parties.sheet,
    patients: patients.sheet, orderLog: olog.sheet, stocktakeLog: slog.sheet
  };
}

/** 発注先シートを読む */
function readParties_(ss) {
  var sh = ensureSheets_(ss).parties;
  var last = sh.getLastRow();
  var map = {}, list = [];
  if (last <= 1) return { map: map, list: list };
  var vals = sh.getRange(2, 1, last - 1, PARTY_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    var name = String(vals[i][0] || '').trim();
    if (!name || name.charAt(0) === '（') continue;      // 説明用のダミー行は無視
    var p = {
      name: name,
      contact: String(vals[i][1] || '').trim(),
      tel: String(vals[i][2] || '').trim(),
      fax: String(vals[i][3] || '').trim(),
      mail: String(vals[i][4] || '').trim(),
      address: String(vals[i][5] || '').trim(),
      honorific: String(vals[i][6] || '').trim() || '御中',
      memo: String(vals[i][7] || '').trim()
    };
    map[name] = p;
    list.push(p);
  }
  return { map: map, list: list };
}

/** 運用設定から自院の情報を組み立てる（発注書の差出人） */
function readFacility_(settings) {
  return {
    name: String(settings['施設名'] || '').trim(),
    dept: String(settings['部署名'] || '').trim(),
    address: String(settings['施設住所'] || '').trim(),
    tel: String(settings['施設TEL'] || '').trim(),
    fax: String(settings['施設FAX'] || '').trim(),
    person: String(settings['発注担当者名'] || '').trim(),
    coverSheet: parseBool_(settings['FAX送付状をつける'], true),
    showAmount: parseBool_(settings['発注書に金額を印刷'], true)
  };
}

/* ==================================================================
   運用設定
   ================================================================== */
function readSettings_(ss) {
  var sh = ensureSheets_(ss).settings;
  var map = {}, rows = {};
  var last = sh.getLastRow();
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) {
      var k = String(vals[i][0]).trim();
      if (!k) continue;
      map[k] = vals[i][1];
      rows[k] = 2 + i;
    }
  }
  // 足りないキーを補う
  var missing = [];
  for (var j = 0; j < SETTINGS_DEFAULTS.length; j++) {
    var d = SETTINGS_DEFAULTS[j];
    if (!(d[0] in map)) { missing.push(d); map[d[0]] = d[1]; }
  }
  if (missing.length) {
    var start = sh.getLastRow() + 1;
    sh.getRange(start, 1, missing.length, 3).setValues(missing);
    for (var k2 = 0; k2 < missing.length; k2++) rows[missing[k2][0]] = start + k2;
  }
  map.__rows = rows;
  return map;
}

function writeSetting_(ss, key, value) {
  var s = readSettings_(ss);
  var row = s.__rows[key];
  if (!row) return false;
  ensureSheets_(ss).settings.getRange(row, 2).setValue(value);
  return true;
}

function parseBool_(v, fallback) {
  if (v === true) return true;
  if (v === false) return false;
  var s = String(v).trim().toUpperCase();
  if (s === 'TRUE' || s === 'はい' || s === '1' || s === 'ON' || s === '○') return true;
  if (s === 'FALSE' || s === 'いいえ' || s === '0' || s === 'OFF' || s === '×') return false;
  return fallback;
}

/** '月,木' → [1,4] */
function parseWeekdays_(v) {
  var out = [];
  String(v || '').split(/[,、\s]+/).forEach(function (t) {
    var s = t.trim().replace(/曜日?$/, '');
    var i = DOW_NAMES.indexOf(s);
    if (i >= 0 && out.indexOf(i) < 0) out.push(i);
  });
  return out.sort(function (a, b) { return a - b; });
}

/**
 * 現在の発注サイクルを解決する。
 * 曜日が指定されていれば「今日から次の発注日まで何日か」を返すので、
 * 月→木は3日、木→月は4日と、実態どおりの間隔で目標在庫が計算されます。
 */
function resolveCycle_(settings, now, tz) {
  var label = String(settings['発注サイクル'] || '週2回').trim();
  var presetDays = CYCLE_PRESETS[label];
  var fallback = (presetDays !== undefined)
    ? presetDays
    : Math.max(0.5, toNum_(settings['カスタム間隔日数'], 3.5));
  var weekdays = parseWeekdays_(settings['発注曜日']);
  var cycleDays = nextOrderDays_(dowOf_(now, tz), weekdays, fallback);
  return {
    label: label,
    cycleDays: cycleDays,
    averageDays: fallback,
    weekdays: weekdays,
    weekdayLabel: weekdays.map(function (d) { return DOW_NAMES[d]; }).join('・')
  };
}

/* ==================================================================
   患者名簿
   ================================================================== */
function splitList_(v) {
  return String(v || '').split(/[,、\/\s]+/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

/**
 * 患者名簿を読んで、全体の在籍数と資材IDごとの人数を返します。
 * モバカルのCSVをそのまま貼れるよう、判定はゆるめ（状態が空欄なら在籍扱い）にしています。
 */
function readPatients_(ss, settings) {
  var sh = ensureSheets_(ss).patients;
  var last = sh.getLastRow();
  var result = { total: 0, byItem: {}, listed: 0, excluded: 0, hasItemIds: false };
  if (last <= 1) return result;

  var includeWords = splitList_(settings['在籍とみなす状態']);
  var excludeWords = splitList_(settings['除外する状態']);
  var vals = sh.getRange(2, 1, last - 1, PATIENT_HEADERS.length).getValues();

  for (var i = 0; i < vals.length; i++) {
    var name = String(vals[i][0] || '').trim();
    if (!name) continue;
    result.listed++;
    var status = String(vals[i][1] || '').trim();

    var excluded = excludeWords.some(function (w) { return status.indexOf(w) >= 0; });
    if (excluded) { result.excluded++; continue; }
    if (includeWords.length && status) {
      var included = includeWords.some(function (w) { return status.indexOf(w) >= 0; });
      if (!included) { result.excluded++; continue; }
    }

    result.total++;
    var ids = splitList_(vals[i][2]);
    if (ids.length) result.hasItemIds = true;
    for (var j = 0; j < ids.length; j++) {
      result.byItem[ids[j]] = (result.byItem[ids[j]] || 0) + 1;
    }
  }
  return result;
}

/** 全体の対象患者数（手入力 or 患者名簿） */
function resolvePatientCount_(settings, patients) {
  var src = String(settings['患者数の取得元'] || '手入力').trim();
  if (src === '患者名簿') return { count: patients.total, source: '患者名簿' };
  return { count: Math.max(0, Math.floor(toNum_(settings['対象患者数(手入力)'], 0))), source: '手入力' };
}

/** 商品ごとの対象患者数 */
function patientCountForItem_(settings, patients, totalCount, itemId) {
  var mode = String(settings['患者数の割当'] || '全体').trim();
  if (mode === '資材IDごと' && patients.hasItemIds) {
    return { count: patients.byItem[itemId] || 0, perItem: true };
  }
  return { count: totalCount, perItem: false };
}

/* ==================================================================
   在庫シート
   ================================================================== */
function readStockRows_(ss) {
  var sh = getStockSheet_(ss);
  var last = sh.getLastRow();
  if (last <= CFG.HEADER_ROWS) return [];
  var width = Math.max(CFG.COL_STOCK, sh.getLastColumn());
  var values = sh.getRange(CFG.HEADER_ROWS + 1, 1, last - CFG.HEADER_ROWS, width).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var id = r[CFG.COL_ID - 1];
    if (id === '' || id === null) continue;
    out.push({
      row: CFG.HEADER_ROWS + 1 + i,
      id: String(id).trim(),
      name: String(r[CFG.COL_NAME - 1] || '規格未設定'),
      fixedTarget: toNum_(r[CFG.COL_FIXED - 1], 0),
      sheetStock: (r[CFG.COL_STOCK - 1] === '' ? null : toNum_(r[CFG.COL_STOCK - 1], null))
    });
  }
  return out;
}

/** E列（現在在庫）をまとめて更新 */
function writeStockColumn_(ss, patches) {
  if (!patches.length) return;
  var sh = getStockSheet_(ss);
  var minRow = patches[0].row, maxRow = patches[0].row;
  for (var i = 1; i < patches.length; i++) {
    if (patches[i].row < minRow) minRow = patches[i].row;
    if (patches[i].row > maxRow) maxRow = patches[i].row;
  }
  var range = sh.getRange(minRow, CFG.COL_STOCK, maxRow - minRow + 1, 1);
  var cur = range.getValues();
  for (var j = 0; j < patches.length; j++) cur[patches[j].row - minRow][0] = patches[j].value;
  range.setValues(cur);
}

/* ==================================================================
   品目設定
   ================================================================== */
function readItemConfig_(ss, stockRows, settings) {
  var sh = ensureSheets_(ss).items;
  var defLead = Math.max(0, toNum_(settings['既定リードタイム日数'], 2));
  var defSafety = Math.max(0, toNum_(settings['既定安全日数'], 7));
  var map = {};
  var last = sh.getLastRow();

  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, ITEM_HEADERS.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (v[0] === '' || v[0] === null) continue;
      var id = String(v[0]).trim();
      map[id] = {
        row: 2 + i,
        id: id,
        name: String(v[1] || ''),
        rate: clamp_(toNum_(v[2], 0.25), 0, LOGIC_CONST.RATE_MAX),
        scales: parseBool_(v[3], true),
        leadDays: Math.max(0, toNum_(v[4], defLead)),
        safetyDays: Math.max(0, toNum_(v[5], defSafety)),
        samples: Math.max(0, Math.floor(toNum_(v[6], 0))),
        lastLearned: (v[7] instanceof Date) ? v[7] : null,
        locked: parseBool_(v[8], false),
        lastObserved: (v[11] === '' ? null : toNum_(v[11], null)),
        memo: String(v[13] || ''),
        party: String(v[ITEM_COL.PARTY - 1] || '').trim(),
        code: String(v[ITEM_COL.CODE - 1] || '').trim(),
        packSize: Math.max(1, Math.floor(toNum_(v[ITEM_COL.PACK_SIZE - 1], 1))),
        packUnit: String(v[ITEM_COL.PACK_UNIT - 1] || '').trim(),
        price: toNum_(v[ITEM_COL.PRICE - 1], null),
        vendorId: String(v[ITEM_COL.VENDOR_ID - 1] || '').trim(),
        maker: String(v[ITEM_COL.MAKER - 1] || '').trim(),
        spec: String(v[ITEM_COL.SPEC - 1] || '').trim(),
        expiry: (v[ITEM_COL.EXPIRY - 1] instanceof Date) ? v[ITEM_COL.EXPIRY - 1] : null,
        expiryWarn: toNum_(v[ITEM_COL.EXPIRY_WARN - 1], null)
      };
    }
  }

  // 在庫シートにあって品目設定に無いものを追記（旧AI設定シートがあれば消費ペースを引き継ぐ）
  var legacy = readLegacyRates_(ss);
  var toAppend = [];
  for (var j = 0; j < stockRows.length; j++) {
    var s = stockRows[j];
    if (map[s.id]) continue;
    var seed = legacy[s.id];
    if (seed === undefined) seed = SEED_RATES[s.id];
    if (seed === undefined) seed = 0.25;
    toAppend.push([s.id, s.name, seed, true, defLead, defSafety, 0, '', false, '', '', '', '', '自動追加',
                   '', '', 1, '', '', '', '', '', '', '']);
  }
  if (toAppend.length) {
    var start = sh.getLastRow() + 1;
    sh.getRange(start, 1, toAppend.length, ITEM_HEADERS.length).setValues(toAppend);
    for (var k = 0; k < toAppend.length; k++) {
      var a = toAppend[k];
      map[String(a[0])] = {
        row: start + k, id: String(a[0]), name: a[1], rate: a[2], scales: true,
        leadDays: a[4], safetyDays: a[5], samples: 0, lastLearned: null,
        locked: false, lastObserved: null, memo: a[13],
        party: '', code: '', packSize: 1, packUnit: '', price: null,
        vendorId: '', maker: '', spec: '', expiry: null, expiryWarn: null
      };
    }
  }
  return map;
}

/** v2の「AI設定」シートが残っていれば週消費ペースだけ引き継ぐ */
function readLegacyRates_(ss) {
  var out = {};
  var sh = ss.getSheetByName('AI設定');
  if (!sh) return out;
  var last = sh.getLastRow();
  if (last <= 1) return out;
  var vals = sh.getRange(2, 1, last - 1, 5).getValues();
  for (var i = 0; i < vals.length; i++) {
    var id = String(vals[i][0] || '').trim();
    var rate = toNum_(vals[i][4], null);
    if (id && rate !== null && rate > 0) out[id] = rate;
  }
  return out;
}

/** 品目設定の自動列と学習結果をまとめて書き戻す（C〜M列を1回のsetValuesで） */
function writeItemUpdates_(ss, updates) {
  if (!updates.length) return;
  var sh = ensureSheets_(ss).items;
  var minRow = updates[0].row, maxRow = updates[0].row;
  for (var i = 1; i < updates.length; i++) {
    if (updates[i].row < minRow) minRow = updates[i].row;
    if (updates[i].row > maxRow) maxRow = updates[i].row;
  }
  var COL_START = 3, COL_COUNT = 11;   // C..M
  var range = sh.getRange(minRow, COL_START, maxRow - minRow + 1, COL_COUNT);
  var cur = range.getValues();
  for (var j = 0; j < updates.length; j++) {
    var u = updates[j], r = cur[u.row - minRow];
    r[0] = u.rate;                                                   // C 週消費ペース
    // r[1] 患者数連動, r[2] リードタイム, r[3] 安全日数 はユーザー設定なので触らない
    r[4] = u.samples;                                                // G 学習回数
    if (u.lastLearned) r[5] = u.lastLearned;                         // H 最終学習日
    // r[6] 手動固定 も触らない
    r[7] = u.target;                                                 // J 目標在庫(自動)
    r[8] = u.recommendedSafetyDays;                                  // K 推奨安全日数(自動)
    r[9] = (u.lastObserved === null || u.lastObserved === undefined) ? '' : u.lastObserved; // L
    r[10] = u.patientCount;                                          // M 対象患者数(自動)
  }
  range.setValues(cur);

  // 使用期限（W列）は離れているので別途まとめて書きます
  var withExpiry = updates.filter(function (u) { return u.expiry !== undefined; });
  if (withExpiry.length) {
    var eMin = withExpiry[0].row, eMax = withExpiry[0].row;
    for (var e = 1; e < withExpiry.length; e++) {
      if (withExpiry[e].row < eMin) eMin = withExpiry[e].row;
      if (withExpiry[e].row > eMax) eMax = withExpiry[e].row;
    }
    var eRange = sh.getRange(eMin, ITEM_COL.EXPIRY, eMax - eMin + 1, 1);
    var eCur = eRange.getValues();
    withExpiry.forEach(function (u) {
      if (u.expiry !== null) eCur[u.row - eMin][0] = u.expiry;
    });
    eRange.setValues(eCur);
  }
}

/* ==================================================================
   ログ（発注 + 棚卸）
   ================================================================== */
function appendRows_(sheet, headers, rows) {
  if (!rows.length) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

/**
 * 商品ごとの「最後に数えた日時と数量」「その後の入荷見込み」を組み立てる。
 * 発注ログと棚卸ログを時系列にマージするので、月1回の棚卸で入れた数値が
 * そのまま次の予測の基準点になります。
 */
function readBaseIndex_(ss) {
  var sheets = ensureSheets_(ss);
  var events = [];

  var ol = sheets.orderLog, oLast = ol.getLastRow();
  if (oLast > 1) {
    var oStart = Math.max(2, oLast - CFG.LOG_MAX_READ + 1);
    var ov = ol.getRange(oStart, 1, oLast - oStart + 1, ORDER_LOG_HEADERS.length).getValues();
    for (var i = 0; i < ov.length; i++) {
      var v = ov[i];
      var id = String(v[4] || '').trim();
      if (!id || !(v[0] instanceof Date)) continue;
      events.push({
        at: v[0], id: id, type: 'order',
        counted: (v[8] === '' || v[8] === null) ? null : toNum_(v[8], null),
        ordered: Math.max(0, toNum_(v[11], 0)),
        patients: toNum_(v[15], null)
      });
    }
  }

  var sl = sheets.stocktakeLog, sLast = sl.getLastRow();
  if (sLast > 1) {
    var sStart = Math.max(2, sLast - CFG.LOG_MAX_READ + 1);
    var sv = sl.getRange(sStart, 1, sLast - sStart + 1, STOCKTAKE_LOG_HEADERS.length).getValues();
    for (var k = 0; k < sv.length; k++) {
      var w = sv[k];
      var sid = String(w[2] || '').trim();
      if (!sid || !(w[0] instanceof Date)) continue;
      events.push({
        at: w[0], id: sid, type: 'stocktake',
        counted: (w[5] === '' || w[5] === null) ? null : toNum_(w[5], null),
        ordered: 0,
        patients: toNum_(w[10], null)
      });
    }
  }

  events.sort(function (a, b) {
    if (a.at.getTime() !== b.at.getTime()) return a.at - b.at;
    return (a.type === 'stocktake' ? 1 : 0) - (b.type === 'stocktake' ? 1 : 0); // 同時刻なら棚卸を後に
  });

  var index = {};
  for (var m = 0; m < events.length; m++) {
    var e = events[m];
    if (!index[e.id]) index[e.id] = { countedAt: null, countedStock: null, receivedSince: 0, patientsThen: null, source: null };
    var t = index[e.id];
    if (e.counted !== null) {
      t.countedAt = e.at;
      t.countedStock = e.counted;
      t.receivedSince = 0;
      t.patientsThen = e.patients;
      t.source = e.type;
    }
    if (t.countedAt) t.receivedSince += e.ordered;
  }
  return index;
}

/**
 * 'yyyy-MM-dd'（画面の日付入力の形式）を Date に変換する。
 * 不正な値は null を返し、シートに変なものが書かれないようにします。
 */
function parseYmd_(v) {
  if (!v) return null;
  var m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  var dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  if (y < 2000 || y > 2100) return null;      // 打ち間違いの年をはじく
  return dt;
}

function sanitizeInt_(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  var n = Math.floor(Number(v));
  if (!isFinite(n) || n < 0) return fallback;
  return Math.min(n, 99999);
}
