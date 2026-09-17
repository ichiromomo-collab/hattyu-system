/**
 * ENFit PEG AI発注アシスト v3 — エントリポイント / 公開API
 * ------------------------------------------------------------------
 * ファイル構成
 *   コード.gs   … doGet・メニュー・画面から呼ばれる関数（このファイル）
 *   Repo.gs    … シートの読み書き
 *   Logic.gs   … 予測・目標在庫・学習の計算（純粋関数／単体テスト済み）
 *   index.html … 画面
 * ------------------------------------------------------------------
 * 【初回にやること】
 *   1. 上の4ファイルを用意して保存
 *   2. スプレッドシートを開き直し、メニュー「発注アシスト」→「初期セットアップ」
 *   3. 「運用設定」シートで発注サイクル・患者数・リードタイムを確認
 *   4. デプロイ → 新しいデプロイ → ウェブアプリ
 */

var APP_VERSION = '3.3';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('ENFit PEG 発注アシスト')
    // GASは<meta>タグを除去するので、viewportはここで指定します（スマホ表示に必須）
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('発注アシスト')
    .addItem('初期セットアップ', 'setupSheets')
    .addItem('従来定数から消費ペースを初期化', 'menuSeedFromFixed')
    .addItem('推奨安全日数を反映', 'menuApplyRecommendedSafety')
    .addSeparator()
    .addItem('患者名簿の貼り付け方', 'menuPatientHelp')
    .addItem('発注先の設定方法', 'menuPartyHelp')
    .addItem('学習をリセット（消費ペースは残す）', 'menuResetLearning')
    .addSeparator()
    .addItem('動作診断（エラーが出たとき）', 'menuDiagnose')
    .addToUi();
}

/* ==================================================================
   動作診断
   ------------------------------------------------------------------
   「◯◯ is not defined」系のエラーは、ほぼ全てファイルの貼り忘れか
   古いバージョンの残骸が原因です。どのファイルが足りないかを特定します。
   ================================================================== */
function diagnose_() {
  // typeof を名前ベタ書きで書いているのは、未定義でも例外にならず、
  // GASのどのランタイムでも確実に判定できるためです。
  var required = [
    ['Logic.gs', [
      ['computeTarget_',        typeof computeTarget_],
      ['roundToPack_',          typeof roundToPack_],
      ['unitsFromPacks_',       typeof unitsFromPacks_],
      ['lineAmount_',           typeof lineAmount_],
      ['predictStock_',         typeof predictStock_],
      ['applyLearning_',        typeof applyLearning_],
      ['nextOrderDays_',        typeof nextOrderDays_],
      ['effectiveWeeklyRate_',  typeof effectiveWeeklyRate_],
      ['recommendSafetyDays_',  typeof recommendSafetyDays_],
      ['stocktakeVariance_',    typeof stocktakeVariance_],
      ['stocktakeDue_',         typeof stocktakeDue_],
      ['expiryStatus_',         typeof expiryStatus_]
    ]],
    ['Repo.gs', [
      ['ensureSheets_',     typeof ensureSheets_],
      ['readSettings_',     typeof readSettings_],
      ['resolveCycle_',     typeof resolveCycle_],
      ['readItemConfig_',   typeof readItemConfig_],
      ['readParties_',      typeof readParties_],
      ['readFacility_',     typeof readFacility_],
      ['readBaseIndex_',    typeof readBaseIndex_],
      ['readPatients_',     typeof readPatients_],
      ['writeItemUpdates_', typeof writeItemUpdates_],
      ['getStockSheet_',    typeof getStockSheet_]
    ]],
    ['コード.gs', [
      ['getBootstrapData', typeof getBootstrapData],
      ['saveOrder',        typeof saveOrder],
      ['saveStocktake',    typeof saveStocktake],
      ['setCycle',         typeof setCycle],
      ['setPatientCount',  typeof setPatientCount],
      ['buildDocuments_',  typeof buildDocuments_],
      ['getPastDocuments', typeof getPastDocuments],
      ['seedRatesFromFixedTargets', typeof seedRatesFromFixedTargets]
    ]]
  ];
  // v2 にしか存在しない関数。見つかったら古いファイルが残っています
  var legacyChecks = [
    ['readConfig_',             typeof readConfig_],
    ['writeConfigUpdates_',     typeof writeConfigUpdates_],
    ['readLogIndex_',           typeof readLogIndex_],
    ['applyRecommendedTargets', typeof applyRecommendedTargets],
    ['recommendTarget_',        typeof recommendTarget_],
    ['updateStock',             typeof updateStock]
  ];

  var missing = [], legacy = [];
  for (var i = 0; i < required.length; i++) {
    var lack = [];
    for (var j = 0; j < required[i][1].length; j++) {
      if (required[i][1][j][1] !== 'function') lack.push(required[i][1][j][0]);
    }
    if (lack.length) missing.push({ file: required[i][0], fns: lack });
  }
  for (var k = 0; k < legacyChecks.length; k++) {
    if (legacyChecks[k][1] === 'function') legacy.push(legacyChecks[k][0]);
  }
  return { ok: (missing.length === 0 && legacy.length === 0), version: APP_VERSION, missing: missing, legacy: legacy };
}

function menuDiagnose() {
  var d = diagnose_();
  var msg = 'バージョン: v' + d.version + '\n\n';
  if (d.ok) {
    msg += '✅ 必要な関数がすべて揃っています。\n古いバージョンの残骸もありません。';
  } else {
    if (d.missing.length) {
      msg += '❌ 貼り付けが足りないファイルがあります:\n';
      d.missing.forEach(function (m) {
        msg += '　・' + m.file + '（' + m.fns.slice(0, 3).join(', ')
            + (m.fns.length > 3 ? ' ほか' + (m.fns.length - 3) + '件' : '') + ' が見つかりません）\n';
      });
      msg += '\n該当ファイルを新規作成して、お渡しした中身を貼り付けてください。\n';
    }
    if (d.legacy.length) {
      msg += '\n⚠️ 古いバージョン(v2)のコードが残っています:\n　' + d.legacy.join(', ') + '\n\n'
          + 'エディタ左のファイル一覧から、v3で置き換えていないファイルを探して\n'
          + '中身をすべて削除し、v3の内容に貼り替えてください。\n'
          + '（各ファイルの1行目付近に「v3」と書いてあるのが新しい方です）\n';
    }
    msg += '\n直したら、必ず「デプロイ → デプロイを管理 → 編集 → バージョン: 新バージョン → デプロイ」まで実行してください。';
  }
  SpreadsheetApp.getUi().alert('動作診断', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

function setupSheets() {
  var ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  var settings = readSettings_(ss);
  var stockRows = readStockRows_(ss);
  readItemConfig_(ss, stockRows, settings);
  var cyc = resolveCycle_(settings, new Date(), ss.getSpreadsheetTimeZone());
  SpreadsheetApp.getUi().alert(
    'セットアップ完了',
    '対象商品: ' + stockRows.length + '件\n' +
    '発注サイクル: ' + cyc.label + (cyc.weekdayLabel ? '（' + cyc.weekdayLabel + '）' : '') + '\n\n' +
    '作成したシート: 運用設定 / 品目設定 / 発注先 / 患者名簿 / 発注ログ / 棚卸ログ\n' +
    '\n発注書を使う場合は、メニュー「発注先の設定方法」も確認してください。\n' +
    '在庫シートの列は変更していません。',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function menuPatientHelp() {
  SpreadsheetApp.getUi().alert(
    '患者名簿の使い方',
    'モバカルから出したCSV / Excel の中身を「患者名簿」シートに貼り付けてください。\n\n' +
    '　A列: 患者ID または 氏名（必須。ここが空の行は無視されます）\n' +
    '　B列: 状態（「中止」「退院」などを含む行は自動で除外されます）\n' +
    '　C列: 使用資材ID をカンマ区切り（任意）\n\n' +
    'C列まで入れて「運用設定」の《患者数の割当》を「資材IDごと」にすると、\n' +
    '商品ごとに「その資材を使っている患者数」で発注量を計算します。\n' +
    'C列が空でも、全体の在籍患者数として使えます。\n\n' +
    '貼り付けたら「運用設定」の《患者数の取得元》を「患者名簿」に変えてください。',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function menuPartyHelp() {
  SpreadsheetApp.getUi().alert(
    '発注書の設定',
    '【1】「発注先」シートに、発注先を1行ずつ書きます\n' +
    '　　発注先名 / 担当者 / TEL / FAX / メール / 住所 / 敬称\n' +
    '　　（1行目のダミー行は消すか、上書きしてください）\n\n' +
    '【2】「品目設定」シートの右側に、商品ごとの情報を入れます\n' +
    '　　・発注先　… 上で書いた発注先名と同じ文字列\n' +
    '　　・メーカー品番\n' +
    '　　・入数　　… 1箱に何本入っているか（ばら売りなら 1 か空欄）\n' +
    '　　・発注単位… 箱 / ケース / 袋 など\n' +
    '　　・単価　　… 発注単位あたりの値段（入数10なら1箱の値段）\n\n' +
    '【3】「運用設定」シートに施設名・住所・TEL・FAXを入れます\n' +
    '　　発注書の差出人として印刷されます\n\n' +
    '入数を入れると、発注数が自動的に箱単位に切り上がります。\n' +
    '（例: 3本必要 → 1箱(10本) と発注書に出て、届く10本で在庫を計算します）',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/**
 * 在庫シートD列の「従来定数」から週消費ペースを逆算して初期値にする。
 *
 * 従来の定数は「これだけ棚に置いておけば回る」という実務の答えなので、
 * 初期値としてはシステムの既定値（0.25本/週）よりずっと正確です。
 * 旧運用が「1週サイクル＋1週の余裕＝2週ぶん」だったとすると
 *
 *     週消費ペース ≒ 従来定数 ÷ 2
 *
 * で逆算できます（この「2」は運用設定の《定数の想定カバー週数》で変えられます）。
 * 同時に基準患者数を現在の対象患者数に合わせるので、患者数の掛け算が1倍になり、
 * 初日から従来定数とほぼ同じ発注数が出ます。
 */
function seedRatesFromFixedTargets() {
  var ss = SpreadsheetApp.getActive();
  var ctx = buildContext_(ss);
  var coverWeeks = Math.max(0.5, toNum_(ctx.settings['定数の想定カバー週数'], 2));

  // 基準患者数を今の対象患者数に合わせる（掛け算を1倍に戻す）
  var basePatientsBefore = ctx.basePatients;
  if (ctx.patientCount > 0 && ctx.patientCount !== ctx.basePatients) {
    writeSetting_(ss, '基準患者数', ctx.patientCount);
  }

  var sh = ensureSheets_(ss).items;
  var last = sh.getLastRow();
  if (last <= 1) return { updated: 0, skippedLearned: 0, skippedLocked: 0, skippedNoFixed: 0,
                          basePatientsBefore: basePatientsBefore, basePatientsAfter: ctx.patientCount, rows: [] };

  var byId = {};
  ctx.items.forEach(function (it) { byId[it.id] = it; });

  var range = sh.getRange(2, 1, last - 1, ITEM_HEADERS.length);
  var vals = range.getValues();
  var updated = 0, skippedLearned = 0, skippedLocked = 0, skippedNoFixed = 0, rows = [];

  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (v[0] === '' || v[0] === null) continue;
    var it = byId[String(v[0]).trim()];
    if (!it) continue;
    if (parseBool_(v[8], false)) { skippedLocked++; continue; }                       // 手動固定
    if (Math.floor(toNum_(v[6], 0)) > 0) { skippedLearned++; continue; }              // すでに学習済み
    if (!(it.fixedTarget > 0)) { skippedNoFixed++; continue; }                        // 定数が無い

    var rate = round2(it.fixedTarget / coverWeeks);
    rate = clamp_(rate, LOGIC_CONST.RATE_MIN, LOGIC_CONST.RATE_MAX);
    if (v[2] !== rate) updated++;
    v[2] = rate;
    rows.push({ id: it.id, name: it.name, fixed: it.fixedTarget, rate: rate });
  }
  range.setValues(vals);

  return {
    updated: updated, skippedLearned: skippedLearned, skippedLocked: skippedLocked,
    skippedNoFixed: skippedNoFixed,
    basePatientsBefore: basePatientsBefore, basePatientsAfter: ctx.patientCount,
    coverWeeks: coverWeeks, rows: rows.slice(0, 8)
  };
}
function round2(v) { return Math.round(v * 100) / 100; }

function menuSeedFromFixed() {
  var ui = SpreadsheetApp.getUi();
  var ctx0 = buildContext_(SpreadsheetApp.getActive());
  var msg = '在庫シートD列の「従来定数」から、週消費ペースを逆算して入れ直します。\n\n'
    + '　週消費ペース ＝ 従来定数 ÷ ' + Math.max(0.5, toNum_(ctx0.settings['定数の想定カバー週数'], 2)) + '週\n\n'
    + 'あわせて「基準患者数」を現在の対象患者数（' + ctx0.patientCount + '人）に合わせます。\n'
    + 'これで患者数の掛け算が1倍に戻り、初日から従来定数とほぼ同じ発注数が出ます。\n\n'
    + '※ すでに学習が進んでいる品目と、手動固定した品目は変更しません。';
  if (ui.alert('従来定数から初期化しますか？', msg, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

  var r = seedRatesFromFixedTargets();
  var body = '更新: ' + r.updated + '件\n'
    + '基準患者数: ' + r.basePatientsBefore + '人 → ' + r.basePatientsAfter + '人\n\n'
    + '除外（学習済み）: ' + r.skippedLearned + '件\n'
    + '除外（手動固定）: ' + r.skippedLocked + '件\n'
    + '除外（定数が空欄）: ' + r.skippedNoFixed + '件';
  if (r.rows.length) {
    body += '\n\n例:\n';
    r.rows.forEach(function (x) {
      body += '　' + x.name.slice(0, 18) + '　定数' + x.fixed + '本 → ' + x.rate + '本/週\n';
    });
  }
  ui.alert('初期化しました', body, ui.ButtonSet.OK);
}

function menuApplyRecommendedSafety() {
  var r = applyRecommendedSafetyDays();
  SpreadsheetApp.getUi().alert(
    '推奨安全日数を反映しました',
    '更新: ' + r.changed + '件\n' +
    '除外（手動固定）: ' + r.skippedLocked + '件\n' +
    '除外（学習' + CFG.MIN_SAMPLES_TO_APPLY + '回未満）: ' + r.skippedFewSamples + '件\n\n' +
    '目標在庫は次回アプリ起動時から新しい安全日数で計算されます。',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function menuResetLearning() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('学習回数をリセットしますか？',
      '次回のカウントが「1件目のサンプル」として強く反映されるようになります。\n' +
      '消費ペースの値そのものは変えません。', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var sh = ensureSheets_(SpreadsheetApp.getActive()).items;
  var last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, 7, last - 1, 1).setValue(0);
    ui.alert((last - 1) + '件の学習回数をリセットしました。');
  }
}

/* ==================================================================
   共通：画面に渡す品目データを組み立てる
   ================================================================== */
function buildContext_(ss) {
  var tz = ss.getSpreadsheetTimeZone();
  var now = new Date();
  ensureSheets_(ss);

  var settings = readSettings_(ss);
  var stockRows = readStockRows_(ss);
  var itemCfg = readItemConfig_(ss, stockRows, settings);
  var baseIndex = readBaseIndex_(ss);
  var parties = readParties_(ss);
  var facility = readFacility_(settings);
  var patients = readPatients_(ss, settings);
  var resolved = resolvePatientCount_(settings, patients);
  var basePatients = Math.max(1, Math.floor(toNum_(settings['基準患者数'], resolved.count || 1)));
  var cycle = resolveCycle_(settings, now, tz);
  var todayIdx = dayIndex_(now, tz);
  var defExpiryWarn = Math.max(0, toNum_(settings['期限警告日数'], 60));

  var props = PropertiesService.getScriptProperties();
  var lastOrderStr = props.getProperty(CFG.PROP_LAST_ORDER);
  var lastOrder = lastOrderStr ? new Date(lastOrderStr) : null;
  var lastStockStr = props.getProperty(CFG.PROP_LAST_STOCKTAKE);
  var lastStocktake = lastStockStr ? new Date(lastStockStr) : null;

  var items = stockRows.map(function (s) {
    var c = itemCfg[s.id];
    var pc = patientCountForItem_(settings, patients, resolved.count, s.id);
    var effRate = effectiveWeeklyRate_(c.rate, c.scales, pc.count, basePatients);
    var target = computeTarget_(effRate, cycle.cycleDays, c.leadDays, c.safetyDays);
    var recSafety = recommendSafetyDays_(effRate, cycle.cycleDays, c.leadDays);

    var h = baseIndex[s.id];
    var base = null, baseAt = null, baseSource = 'none', received = 0;
    if (h && h.countedAt && h.countedStock !== null) {
      received = h.receivedSince;
      base = h.countedStock + received;
      baseAt = h.countedAt;
      baseSource = (h.source === 'stocktake') ? 'stocktake' : 'log';
    } else if (s.sheetStock !== null) {
      base = s.sheetStock;
      baseAt = lastOrder;
      baseSource = 'sheet';
    }
    var days = baseAt ? diffDays_(baseAt, now, tz) : 0;
    var predicted = (base === null) ? null : predictStock_(base, effRate, days);

    return {
      row: s.row, id: s.id, name: s.name, fixedTarget: s.fixedTarget,
      rate: c.rate, scales: c.scales, leadDays: c.leadDays, safetyDays: c.safetyDays,
      samples: c.samples, locked: c.locked, lastObserved: c.lastObserved, memo: c.memo,
      patientCount: pc.count, perItemPatients: pc.perItem,
      effRate: round2_(effRate),
      target: target,
      recommendedSafetyDays: recSafety,
      targetAtRecommended: computeTarget_(effRate, cycle.cycleDays, c.leadDays, recSafety),
      baseStock: (base === null) ? null : round1_(base),
      baseSource: baseSource,
      receivedSince: received,
      countedStock: (h && h.countedStock !== null) ? h.countedStock : null,
      lastCountedLabel: baseAt ? fmtDate_(baseAt, tz) : null,
      elapsedDays: days,
      predicted: (predicted === null) ? null : round1_(predicted),
      stockoutDays: (predicted === null) ? null : daysUntilStockout_(predicted, effRate),
      // ---- 発注書まわり ----
      party: c.party,
      partyKnown: !!(c.party && parties.map[c.party]),
      code: c.code,
      vendorId: c.vendorId,
      maker: c.maker,
      spec: c.spec,
      packSize: c.packSize,
      packUnit: c.packUnit || (c.packSize > 1 ? '箱' : '本'),
      price: c.price,
      // ---- 使用期限 ----
      expiry: c.expiry ? Utilities.formatDate(c.expiry, tz, 'yyyy-MM-dd') : null,
      expiryLabel: c.expiry ? Utilities.formatDate(c.expiry, tz, 'yyyy/M/d') : null,
      expiryStatus: (function () {
        var w = (c.expiryWarn === null) ? defExpiryWarn : Math.max(0, c.expiryWarn);
        var st = expiryStatus_(c.expiry ? dayIndex_(c.expiry, tz) : null, todayIdx, w);
        return { level: st.level, days: st.days, warnDays: w };
      })(),
      cfgRow: c.row
    };
  });

  return {
    tz: tz, now: now, settings: settings, stockRows: stockRows, itemCfg: itemCfg,
    baseIndex: baseIndex, patients: patients, patientCount: resolved.count,
    patientSource: resolved.source, basePatients: basePatients, cycle: cycle,
    parties: parties, facility: facility,
    lastOrder: lastOrder, lastStocktake: lastStocktake, items: items
  };
}

/** 発注書番号 yyyyMMdd-NN。当日ぶんの最大値を見て次を採る */
function nextDocSeq_(ss, datePrefix) {
  var sh = ensureSheets_(ss).orderLog;
  var last = sh.getLastRow();
  if (last <= 1) return 1;
  var start = Math.max(2, last - 1000);
  var vals = sh.getRange(start, 18, last - start + 1, 1).getValues();   // R列: 発注書番号
  var max = 0;
  for (var i = 0; i < vals.length; i++) {
    var s = String(vals[i][0] || '');
    if (s.indexOf(datePrefix + '-') !== 0) continue;
    var n = parseInt(s.slice(datePrefix.length + 1), 10);
    if (isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * 発注明細を発注先ごとにまとめて、印刷用の発注書データを組み立てる。
 * lines は [{ item, packs, units }]。
 */
function buildDocuments_(ctx, lines, now, assignNumbers, ss) {
  var groups = {}, order = [];
  lines.forEach(function (ln) {
    var key = ln.item.party || '（発注先未設定）';
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(ln);
  });
  order.sort();

  var datePrefix = Utilities.formatDate(now, ctx.tz, 'yyyyMMdd');
  var seq = assignNumbers ? nextDocSeq_(ss, datePrefix) : 0;

  return order.map(function (key) {
    var p = ctx.parties.map[key] || { name: key, honorific: '御中', contact: '', tel: '', fax: '', mail: '', address: '' };
    var rows = groups[key].map(function (ln) {
      var amount = lineAmount_(ln.packs, ln.item.price);
      return {
        id: ln.item.id,
        code: ln.item.code,
        vendorId: ln.item.vendorId,
        maker: ln.item.maker,
        spec: ln.item.spec,
        name: ln.item.name,
        packs: ln.packs,
        packSize: ln.item.packSize,
        packUnit: ln.item.packUnit,
        units: ln.units,
        price: (ln.item.price === null || !(ln.item.price > 0)) ? null : ln.item.price,
        amount: amount
      };
    });
    var total = 0, hasAll = true;
    rows.forEach(function (r) { if (r.amount === null) hasAll = false; else total += r.amount; });
    return {
      docNo: assignNumbers ? (datePrefix + '-' + ('0' + (seq++)).slice(-2)) : '',
      dateLabel: Utilities.formatDate(now, ctx.tz, 'yyyy年M月d日'),
      party: p,
      known: !!ctx.parties.map[key],
      rows: rows,
      total: hasAll ? total : null,
      totalPartial: !hasAll
    };
  });
}

/** 品目設定シートの自動列を最新化（値が変わったときだけ書く） */
function refreshAutoColumns_(ss, ctx) {
  var updates = [], changed = false;
  var sh = ensureSheets_(ss).items;
  var last = sh.getLastRow();
  if (last <= 1) return;
  var range = sh.getRange(2, 10, last - 1, 4);   // J..M
  var cur = range.getValues();
  ctx.items.forEach(function (it) {
    var i = it.cfgRow - 2;
    if (i < 0 || i >= cur.length) return;
    var want = [it.target, it.recommendedSafetyDays,
                (it.lastObserved === null ? '' : it.lastObserved), it.patientCount];
    for (var k = 0; k < 4; k++) {
      if (cur[i][k] !== want[k]) { cur[i][k] = want[k]; changed = true; }
    }
  });
  if (changed) range.setValues(cur);
}

/* ==================================================================
   画面 → サーバー
   ================================================================== */

function getBootstrapData() {
  var ss = SpreadsheetApp.getActive();
  var ctx = buildContext_(ss);
  refreshAutoColumns_(ss, ctx);

  var todayIdx = dayIndex_(ctx.now, ctx.tz);
  var stCycle = Math.max(1, Math.floor(toNum_(ctx.settings['棚卸周期(日)'], 30)));
  var st = stocktakeDue_(ctx.lastStocktake ? dayIndex_(ctx.lastStocktake, ctx.tz) : null, todayIdx, stCycle);

  return {
    items: ctx.items.map(function (it) { delete it.cfgRow; return it; }),
    meta: {
      version: '3.0',
      today: fmtDate_(ctx.now, ctx.tz),
      user: currentUser_(),
      cycle: {
        label: ctx.cycle.label,
        cycleDays: ctx.cycle.cycleDays,
        averageDays: ctx.cycle.averageDays,
        weekdayLabel: ctx.cycle.weekdayLabel,
        options: Object.keys(CYCLE_PRESETS).concat(['カスタム'])
      },
      patients: {
        count: ctx.patientCount,
        source: ctx.patientSource,
        base: ctx.basePatients,
        ratio: (ctx.basePatients > 0) ? Math.round((ctx.patientCount / ctx.basePatients) * 10) / 10 : null,
        scaledItems: ctx.items.filter(function (it) { return it.scales; }).length,
        listed: ctx.patients.listed,
        excluded: ctx.patients.excluded,
        perItemMode: String(ctx.settings['患者数の割当'] || '全体') === '資材IDごと'
      },
      stocktake: {
        due: st.due, elapsed: st.elapsed, cycleDays: stCycle,
        lastLabel: ctx.lastStocktake ? fmtDateTime_(ctx.lastStocktake, ctx.tz) : null
      },
      lastOrderLabel: ctx.lastOrder ? fmtDateTime_(ctx.lastOrder, ctx.tz) : null,
      lastOrderDays: ctx.lastOrder ? diffDays_(ctx.lastOrder, ctx.now, ctx.tz) : null,
      assumeReceivedDefault: parseBool_(ctx.settings['前回発注分は入荷済みとみなす'], true),
      facility: ctx.facility,
      docLayout: String(ctx.settings['発注書レイアウト'] || '取引先様式').trim(),
      expiryWarnDefault: Math.max(0, toNum_(ctx.settings['期限警告日数'], 60)),
      parties: ctx.parties.list,
      partiesConfigured: ctx.parties.list.length > 0,
      itemsWithoutParty: ctx.items.filter(function (it) { return !it.party; }).length
    }
  };
}

/** 画面から発注サイクルを変更する */
function setCycle(label) {
  var ss = SpreadsheetApp.getActive();
  var ok = ['週2回', '週1回', '隔週', 'カスタム'].indexOf(String(label)) >= 0;
  if (!ok) throw new Error('不明な発注サイクルです: ' + label);
  writeSetting_(ss, '発注サイクル', label);
  return getBootstrapData();
}

/** 画面から患者数を変更する（手入力モードのときだけ有効） */
function setPatientCount(n) {
  var ss = SpreadsheetApp.getActive();
  var v = sanitizeInt_(n, null);
  if (v === null) throw new Error('患者数の指定が正しくありません。');
  var settings = readSettings_(ss);
  if (String(settings['患者数の取得元'] || '手入力').trim() === '患者名簿') {
    throw new Error('患者数は「患者名簿」シートから集計しています。手入力に切り替える場合は運用設定シートを変更してください。');
  }
  writeSetting_(ss, '対象患者数(手入力)', v);
  return getBootstrapData();
}

/**
 * 発注を確定する。
 * payload = { assumeReceived, force, items:[{id,row,stock|null,order}] }
 */
function saveOrder(payload) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('別の端末が保存中です。30秒ほど待ってからもう一度お試しください。');
  try {
    if (!payload || !payload.items || !payload.items.length) throw new Error('保存するデータがありません。');
    var ss = SpreadsheetApp.getActive();
    var props = PropertiesService.getScriptProperties();
    var now = new Date();

    var lastOrderStr = props.getProperty(CFG.PROP_LAST_ORDER);
    if (lastOrderStr && !payload.force) {
      var mins = (now - new Date(lastOrderStr)) / 60000;
      if (mins < CFG.RESUBMIT_GUARD_MIN) {
        return { ok: false, needsConfirm: true,
          message: Math.round(mins) + '分前に確定済みです。もう一度確定すると経過日数の起算日が今日にリセットされます。続けますか？' };
      }
    }

    var ctx = buildContext_(ss);
    var assumeReceived = (payload.assumeReceived !== false);
    var byId = {};
    ctx.items.forEach(function (it) { byId[it.id] = it; });

    var stockPatches = [], logRows = [], itemUpdates = [], learned = [], docLines = [];
    var counted = 0, totalOrder = 0;

    // --- 先に発注書を組み立てて番号を採る（ログにも書き込むため）---
    payload.items.forEach(function (raw) {
      var it = byId[String(raw.id)];
      if (!it) return;
      var packs = sanitizeInt_(raw.packs, 0);
      if (packs > 0) docLines.push({ item: it, packs: packs, units: unitsFromPacks_(packs, it.packSize) });
    });
    var documents = buildDocuments_(ctx, docLines, now, true, ss);
    var docByItem = {};
    documents.forEach(function (d) {
      d.rows.forEach(function (r) { docByItem[r.id] = { docNo: d.docNo, party: d.party.name, packs: r.packs, amount: r.amount }; });
    });

    payload.items.forEach(function (raw) {
      var it = byId[String(raw.id)];
      if (!it) return;                                  // シートから消えた品目は無視
      var cfg = ctx.itemCfg[it.id];
      var packs = sanitizeInt_(raw.packs, 0);
      var order = unitsFromPacks_(packs, it.packSize);   // 実際に届く本数
      var stock = (raw.stock === null || raw.stock === undefined || raw.stock === '')
        ? null : sanitizeInt_(raw.stock, null);
      totalOrder += order;

      var h = ctx.baseIndex[it.id] || { countedAt: null, countedStock: null, receivedSince: 0, patientsThen: null };
      var days = h.countedAt ? diffDays_(h.countedAt, now, ctx.tz) : 0;
      var received = assumeReceived ? h.receivedSince : 0;
      var patientsThen = (h.patientsThen !== null && h.patientsThen !== undefined && h.patientsThen > 0)
        ? h.patientsThen : it.patientCount;

      var res = { rate: cfg.rate, samples: cfg.samples, observedWeekly: null, normalizedWeekly: null, adopted: false, note: '未計測' };
      if (stock !== null) {
        counted++;
        if (h.countedStock === null) {
          res.note = '初回カウント（次回から学習）';
        } else if (!assumeReceived && h.receivedSince > 0) {
          res.note = '入荷未確認のため学習スキップ';
        } else {
          res = applyLearning_(
            { rate: cfg.rate, samples: cfg.samples, locked: cfg.locked, scales: cfg.scales },
            { prevStock: h.countedStock, receivedSince: received, currentStock: stock,
              days: days, patientsThen: patientsThen, basePatients: ctx.basePatients }
          );
        }
      }
      if (res.adopted) learned.push({ name: it.name, from: cfg.rate, to: res.rate, observed: res.normalizedWeekly });

      var newEff = effectiveWeeklyRate_(res.rate, cfg.scales, it.patientCount, ctx.basePatients);
      itemUpdates.push({
        row: cfg.row, rate: res.rate, samples: res.samples,
        lastLearned: res.adopted ? now : null,
        target: computeTarget_(newEff, ctx.cycle.cycleDays, cfg.leadDays, cfg.safetyDays),
        recommendedSafetyDays: recommendSafetyDays_(newEff, ctx.cycle.cycleDays, cfg.leadDays),
        lastObserved: (res.normalizedWeekly === null) ? cfg.lastObserved : res.normalizedWeekly,
        patientCount: it.patientCount
        // expiry は渡さない＝発注では使用期限に触れない
      });

      if (stock !== null) stockPatches.push({ row: it.row, value: stock });

      var doc = docByItem[it.id] || null;
      logRows.push([
        now, currentUser_(), ctx.cycle.label + '(' + ctx.cycle.cycleDays + '日)', days,
        it.id, it.name,
        (h.countedStock === null ? '' : h.countedStock), received,
        (stock === null ? '' : stock),
        (it.predicted === null ? '' : it.predicted),
        it.target, order,
        (res.observedWeekly === null || stock === null) ? '' : observedConsumption_(h.countedStock, received, stock),
        (res.observedWeekly === null ? '' : res.observedWeekly),
        res.rate, it.patientCount, res.note,
        doc ? doc.docNo : '', doc ? doc.party : '', packs,
        (doc && doc.amount !== null && doc.amount !== undefined) ? doc.amount : ''
      ]);
    });

    var sheets = ensureSheets_(ss);
    writeStockColumn_(ss, stockPatches);
    appendRows_(sheets.orderLog, ORDER_LOG_HEADERS, logRows);
    writeItemUpdates_(ss, itemUpdates);
    props.setProperty(CFG.PROP_LAST_ORDER, now.toISOString());

    return {
      ok: true, mode: 'order',
      summary: {
        savedAt: fmtDateTime_(now, ctx.tz), items: logRows.length,
        counted: counted, totalOrder: totalOrder,
        cycle: ctx.cycle.label, cycleDays: ctx.cycle.cycleDays, patients: ctx.patientCount
      },
      learned: learned,
      documents: documents,
      facility: ctx.facility
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 棚卸（月1回）を確定する。
 * payload = { items:[{id, counted}] , note }
 * 棚卸の実測値はそのまま次の予測の基準点になります。
 */
function saveStocktake(payload) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('別の端末が保存中です。30秒ほど待ってからもう一度お試しください。');
  try {
    if (!payload || !payload.items) throw new Error('保存するデータがありません。');
    var ss = SpreadsheetApp.getActive();
    var now = new Date();
    var ctx = buildContext_(ss);
    var byId = {};
    ctx.items.forEach(function (it) { byId[it.id] = it; });

    var stockPatches = [], logRows = [], itemUpdates = [], variances = [];
    var counted = 0, totalDiff = 0, expiryUpdated = 0;

    payload.items.forEach(function (raw) {
      var it = byId[String(raw.id)];
      if (!it) return;
      var cfg = ctx.itemCfg[it.id];
      var c = (raw.counted === null || raw.counted === undefined || raw.counted === '')
        ? null : sanitizeInt_(raw.counted, null);
      var expiry = parseYmd_(raw.expiry);
      if (c === null && expiry === null) return;    // 数えても期限も入れていない品目は記録しない
      if (c === null) return;
      counted++;

      var theoretical = (it.predicted === null) ? 0 : it.predicted;
      var v = stocktakeVariance_(theoretical, c);
      totalDiff += v.diff;
      if (Math.abs(v.diff) >= 1) variances.push({ name: it.name, theoretical: theoretical, counted: c, diff: v.diff });

      var h = ctx.baseIndex[it.id] || { countedAt: null, countedStock: null, receivedSince: 0, patientsThen: null };
      var days = h.countedAt ? diffDays_(h.countedAt, now, ctx.tz) : 0;
      var patientsThen = (h.patientsThen > 0) ? h.patientsThen : it.patientCount;

      var res = { rate: cfg.rate, samples: cfg.samples, observedWeekly: null, normalizedWeekly: null, adopted: false, note: '初回棚卸' };
      if (h.countedStock !== null) {
        res = applyLearning_(
          { rate: cfg.rate, samples: cfg.samples, locked: cfg.locked, scales: cfg.scales },
          { prevStock: h.countedStock, receivedSince: h.receivedSince, currentStock: c,
            days: days, patientsThen: patientsThen, basePatients: ctx.basePatients }
        );
      }

      var newEff = effectiveWeeklyRate_(res.rate, cfg.scales, it.patientCount, ctx.basePatients);
      itemUpdates.push({
        row: cfg.row, rate: res.rate, samples: res.samples,
        lastLearned: res.adopted ? now : null,
        target: computeTarget_(newEff, ctx.cycle.cycleDays, cfg.leadDays, cfg.safetyDays),
        recommendedSafetyDays: recommendSafetyDays_(newEff, ctx.cycle.cycleDays, cfg.leadDays),
        lastObserved: (res.normalizedWeekly === null) ? cfg.lastObserved : res.normalizedWeekly,
        patientCount: it.patientCount,
        expiry: expiry                                  // null なら既存の期限を残す
      });
      if (expiry) expiryUpdated++;

      stockPatches.push({ row: it.row, value: c });
      logRows.push([
        now, currentUser_(), it.id, it.name, theoretical, c, v.diff,
        (v.rate === null ? '' : v.rate),
        (h.countedAt ? h.countedAt : ''), days, it.patientCount,
        (res.observedWeekly === null ? '' : res.observedWeekly),
        res.rate,
        (String(payload.note || '') + (res.note ? ' ' + res.note : '')).trim(),
        expiry || ''
      ]);
    });

    if (!counted) throw new Error('実棚卸数が1件も入力されていません。');

    var sheets = ensureSheets_(ss);
    writeStockColumn_(ss, stockPatches);
    appendRows_(sheets.stocktakeLog, STOCKTAKE_LOG_HEADERS, logRows);
    writeItemUpdates_(ss, itemUpdates);
    PropertiesService.getScriptProperties().setProperty(CFG.PROP_LAST_STOCKTAKE, now.toISOString());

    variances.sort(function (a, b) { return Math.abs(b.diff) - Math.abs(a.diff); });
    return {
      ok: true, mode: 'stocktake',
      summary: {
        savedAt: fmtDateTime_(now, ctx.tz), counted: counted,
        total: ctx.items.length, totalDiff: round1_(totalDiff),
        expiryUpdated: expiryUpdated,
        nextDue: Math.max(1, Math.floor(toNum_(ctx.settings['棚卸周期(日)'], 30)))
      },
      variances: variances.slice(0, 10)
    };
  } finally {
    lock.releaseLock();
  }
}

/** 品目設定の「安全日数」を統計的な推奨値に置き換える */
function applyRecommendedSafetyDays() {
  var ss = SpreadsheetApp.getActive();
  var ctx = buildContext_(ss);
  var sh = ensureSheets_(ss).items;
  var last = sh.getLastRow();
  if (last <= 1) return { changed: 0, skippedLocked: 0, skippedFewSamples: 0 };

  var range = sh.getRange(2, 1, last - 1, ITEM_HEADERS.length);
  var vals = range.getValues();
  var byRow = {};
  ctx.items.forEach(function (it) { byRow[it.row] = it; });
  var cfgByRow = {};
  Object.keys(ctx.itemCfg).forEach(function (id) { cfgByRow[ctx.itemCfg[id].row] = ctx.itemCfg[id]; });
  var itemById = {};
  ctx.items.forEach(function (it) { itemById[it.id] = it; });

  var changed = 0, skippedLocked = 0, skippedFew = 0;
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (v[0] === '' || v[0] === null) continue;
    var it = itemById[String(v[0]).trim()];
    if (!it) continue;
    v[10] = it.recommendedSafetyDays;                       // K 推奨安全日数は常に最新に
    if (parseBool_(v[8], false)) { skippedLocked++; continue; }
    if (Math.floor(toNum_(v[6], 0)) < CFG.MIN_SAMPLES_TO_APPLY) { skippedFew++; continue; }
    if (v[5] !== it.recommendedSafetyDays) { v[5] = it.recommendedSafetyDays; changed++; }
  }
  range.setValues(vals);
  return { changed: changed, skippedLocked: skippedLocked, skippedFewSamples: skippedFew };
}

/**
 * 過去の発注書を再印刷するためのデータを返す。
 * 発注ログに全項目が残っているので、いつでも同じ発注書を作り直せます。
 */
function getPastDocuments(limit) {
  var ss = SpreadsheetApp.getActive();
  var tz = ss.getSpreadsheetTimeZone();
  var settings = readSettings_(ss);
  var facility = readFacility_(settings);
  var parties = readParties_(ss);
  // 品番・入数などは品目設定シートの現在値から補います（ログには数量だけ残しているため）
  var itemCfg = readItemConfig_(ss, readStockRows_(ss), settings);
  var sh = ensureSheets_(ss).orderLog;
  var last = sh.getLastRow();
  if (last <= 1) return { facility: facility, batches: [] };

  var max = Math.max(1, Math.min(20, Math.floor(toNum_(limit, 5))));
  var start = Math.max(2, last - 2000);
  var vals = sh.getRange(start, 1, last - start + 1, ORDER_LOG_HEADERS.length).getValues();

  var byDoc = {}, docOrder = [];
  for (var i = vals.length - 1; i >= 0; i--) {
    var v = vals[i];
    var docNo = String(v[17] || '').trim();
    if (!docNo || !(v[0] instanceof Date)) continue;
    if (!byDoc[docNo]) {
      if (docOrder.length >= max * 6) break;             // 読みすぎ防止
      byDoc[docNo] = {
        docNo: docNo, at: v[0], dateLabel: Utilities.formatDate(v[0], tz, 'yyyy年M月d日'),
        atLabel: fmtDateTime_(v[0], tz), partyName: String(v[18] || ''), rows: []
      };
      docOrder.push(docNo);
    }
    var id = String(v[4]);
    var c = itemCfg[id] || {};
    byDoc[docNo].rows.unshift({
      id: id, name: String(v[5]),
      code: c.code || '',
      packSize: c.packSize || 1,
      packUnit: c.packUnit || ((c.packSize > 1) ? '箱' : '本'),
      price: (c.price === null || c.price === undefined || !(c.price > 0)) ? null : c.price,
      packs: toNum_(v[19], 0), units: toNum_(v[11], 0),
      amount: (v[20] === '' ? null : toNum_(v[20], null))
    });
  }

  // 確定日時ごとにまとめる
  var batches = {}, batchOrder = [];
  docOrder.forEach(function (no) {
    var d = byDoc[no];
    var key = d.at.getTime();
    if (!batches[key]) { batches[key] = { atLabel: d.atLabel, at: key, docs: [] }; batchOrder.push(key); }
    var p = parties.map[d.partyName] || { name: d.partyName || '（発注先未設定）', honorific: '御中', contact: '', tel: '', fax: '', mail: '', address: '' };
    var total = 0, hasAll = true;
    d.rows.forEach(function (r) { if (r.amount === null) hasAll = false; else total += r.amount; });
    batches[key].docs.push({
      docNo: d.docNo, dateLabel: d.dateLabel, party: p, known: !!parties.map[d.partyName],
      rows: d.rows, total: hasAll ? total : null, totalPartial: !hasAll, reprint: true
    });
  });

  batchOrder.sort(function (a, b) { return b - a; });
  return {
    facility: facility,
    batches: batchOrder.slice(0, max).map(function (k) {
      batches[k].docs.sort(function (a, b) { return a.docNo < b.docNo ? -1 : 1; });
      return batches[k];
    })
  };
}

/** 直近の確定内容 */
function getLastOrderSummary() {
  var ss = SpreadsheetApp.getActive();
  var tz = ss.getSpreadsheetTimeZone();
  var sh = ensureSheets_(ss).orderLog;
  var last = sh.getLastRow();
  if (last <= 1) return null;
  var start = Math.max(2, last - 300);
  var vals = sh.getRange(start, 1, last - start + 1, ORDER_LOG_HEADERS.length).getValues();
  var latest = null;
  for (var i = vals.length - 1; i >= 0; i--) {
    if (vals[i][0] instanceof Date) { latest = vals[i][0].getTime(); break; }
  }
  if (!latest) return null;
  var rows = vals.filter(function (v) {
    return (v[0] instanceof Date) && v[0].getTime() === latest && toNum_(v[11], 0) > 0;
  }).map(function (v) { return { id: String(v[4]), name: String(v[5]), qty: toNum_(v[11], 0) }; });
  return { at: fmtDateTime_(new Date(latest), tz), rows: rows };
}

/** 発注リストを自分宛にメールする */
function emailOrderList(subject, body) {
  var to = currentUser_();
  if (!to || to === '(不明)') throw new Error('メールアドレスを取得できませんでした。');
  MailApp.sendEmail(to, String(subject).slice(0, 200), String(body).slice(0, 20000));
  return to;
}
