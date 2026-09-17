/**
 * ENFit PEG AI発注アシスト v3 — 計算ロジック（純粋関数のみ）
 * ------------------------------------------------------------------
 * このファイルはスプレッドシートに一切触れません。入力を受けて数値を返すだけです。
 * そのぶん単体テストが書けるので、発注数の計算という一番間違えたくない部分を
 * ここに隔離しています。
 * ------------------------------------------------------------------
 */

var LOGIC_CONST = {
  LEARN_MIN_DAYS: 3,       // これ未満の計測間隔は学習に使わない
  ALPHA_FLOOR: 0.25,       // 学習率の下限（大きいほど直近重視）
  RATE_MIN: 0.02,
  RATE_MAX: 200,
  MAX_TARGET: 999
};

function clamp_(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function round1_(v) { return Math.round(v * 10) / 10; }
function round2_(v) { return Math.round(v * 100) / 100; }
function toNum_(v, fallback) {
  if (v === '' || v === null || v === undefined) return fallback;
  var n = Number(v);
  return isFinite(n) ? n : fallback;
}

/* ==================================================================
   1. 発注サイクル
   ================================================================== */

/**
 * 次の発注日までの日数。
 * 曜日固定運用（例: 月・木）なら実際の間隔（月→木は3日、木→月は4日）を返します。
 * 曜日を決めていない運用なら平均間隔（週2回なら3.5日）をそのまま使います。
 *
 * @param {number}   todayDow   今日の曜日 0=日 … 6=土
 * @param {number[]} weekdays   発注曜日の配列。空なら fallbackDays を返す
 * @param {number}   fallbackDays 曜日を使わないときの平均間隔
 */
function nextOrderDays_(todayDow, weekdays, fallbackDays) {
  if (!weekdays || !weekdays.length) return fallbackDays;
  for (var d = 1; d <= 7; d++) {
    if (weekdays.indexOf((todayDow + d) % 7) >= 0) return d;
  }
  return fallbackDays;
}

/* ==================================================================
   2. 患者数による補正
   ================================================================== */

/**
 * 実効の週消費ペース。
 * 品目設定の「週消費ペース」は “基準患者数のときの消費量” として保存し、
 * 実際の患者数に比例させます（比例させない品目は連動OFFにする）。
 */
function effectiveWeeklyRate_(baseRate, scalesWithPatients, patients, basePatients) {
  if (!scalesWithPatients) return baseRate;
  if (!(basePatients > 0) || !(patients >= 0)) return baseRate;
  return baseRate * (patients / basePatients);
}

/** 学習時、観測した消費ペースを「基準患者数だったら何本か」に引き戻す */
function normalizeToBase_(observedWeekly, scalesWithPatients, patientsThen, basePatients) {
  if (!scalesWithPatients) return observedWeekly;
  if (!(patientsThen > 0) || !(basePatients > 0)) return observedWeekly;
  return observedWeekly * (basePatients / patientsThen);
}

/* ==================================================================
   3. 在庫予測と発注数
   ================================================================== */

/** 予測在庫。小数のまま保持し、表示のときだけ丸める */
function predictStock_(baseStock, effWeeklyRate, days) {
  var daily = Math.max(0, effWeeklyRate) / 7;
  return Math.max(0, baseStock - daily * days);
}

/**
 * 目標在庫 = 次回発注日 + リードタイム + 安全日数 をカバーできる量。
 *
 *   目標 = ceil( 1日消費 × (サイクル日数 + リードタイム日数 + 安全日数) )
 *
 * 安全日数7・リードタイム0のとき、v2の「週ペース×(サイクル週+1週)」と完全に一致するので
 * 現在の手設定（20件中19件が一致）からの連続性が保たれます。
 */
function computeTarget_(effWeeklyRate, cycleDays, leadDays, safetyDays) {
  var daily = Math.max(0, effWeeklyRate) / 7;
  var cover = Math.max(0, cycleDays) + Math.max(0, leadDays) + Math.max(0, safetyDays);
  return clamp_(Math.max(1, Math.ceil(daily * cover - 1e-9)), 1, LOGIC_CONST.MAX_TARGET);
}

/**
 * 安全日数の推奨値。
 *
 * 資材の消費は「1日◯本ずつきれいに減る」のではなく日によってばらつきます。
 * 消費がポアソン分布に従うと仮定すると、露出期間（サイクル＋リードタイム）の
 * 需要のばらつきは √(平均需要) に比例するので、
 *
 *   安全在庫(本) = z × √(1日消費 × 露出日数)
 *   安全日数     = 安全在庫 ÷ 1日消費 = z × √(露出日数 × 7 ÷ 週ペース)
 *
 * z=1.65 でおよそ95%の確率で欠品しない水準です。
 * 消費が遅い品目ほど「1本のブレ」が相対的に大きいので、安全日数は長めに出ます。
 */
function recommendSafetyDays_(effWeeklyRate, cycleDays, leadDays, z) {
  if (!(effWeeklyRate > 0)) return 0;
  var zz = (z === null || z === undefined) ? 1.65 : z;
  var exposure = Math.max(0.5, Math.max(0, cycleDays) + Math.max(0, leadDays));
  return clamp_(Math.round(zz * Math.sqrt(exposure * 7 / effWeeklyRate)), 2, 60);
}

/** 発注数。予測が小数でも「足りなくなる方」に倒れないよう切り上げ */
function orderQty_(target, effectiveStock) {
  return Math.max(0, Math.ceil(target - effectiveStock - 1e-9));
}

/** 在庫が尽きるまでの日数（消費ゼロなら null） */
function daysUntilStockout_(stock, effWeeklyRate) {
  if (!(effWeeklyRate > 0)) return null;
  return Math.floor(stock / (effWeeklyRate / 7));
}

/* ==================================================================
   3b. 発注単位（入数・箱）
   ------------------------------------------------------------------
   「3本足りない」でも10本入りの箱でしか買えない品目があります。
   本数のまま発注書に書くと、届くのは10本なのに記録は3本になり、
   次回の予測在庫が7本ぶんズレます。ここで箱単位に丸め、
   「実際に届く本数」をシステムの発注数として扱います。
   ================================================================== */

/** 必要本数から発注する箱（ケース）数を求める */
function packsNeeded_(neededUnits, packSize) {
  var ps = Math.max(1, Math.floor(packSize || 1));
  if (!(neededUnits > 0)) return 0;
  return Math.ceil(neededUnits / ps - 1e-9);
}

/** 箱数から実際に届く本数を求める */
function unitsFromPacks_(packs, packSize) {
  var ps = Math.max(1, Math.floor(packSize || 1));
  return Math.max(0, Math.floor(packs)) * ps;
}

/** 発注数（本）を発注単位に丸めた結果 */
function roundToPack_(neededUnits, packSize) {
  var packs = packsNeeded_(neededUnits, packSize);
  return { packs: packs, units: unitsFromPacks_(packs, packSize) };
}

/** 明細の金額。単価は「発注単位あたり」（入数1なら1本の値段） */
function lineAmount_(packs, unitPrice) {
  var p = toNum_(unitPrice, 0);
  if (!(p > 0)) return null;
  return Math.round(packs * p);
}

/* ==================================================================
   4. 実績からの学習
   ================================================================== */

/** 実消費量 = 前回実測 + その後の入荷 − 今回実測 */
function observedConsumption_(prevStock, receivedSince, currentStock) {
  return (prevStock + receivedSince) - currentStock;
}

/** 学習サンプルとして信頼できるか */
function isValidSample_(prevStock, receivedSince, currentStock, days) {
  if (!(days >= LOGIC_CONST.LEARN_MIN_DAYS)) return false;
  if (currentStock === null || currentStock === undefined) return false;
  if (!isFinite(currentStock) || currentStock < 0) return false;
  if (prevStock === null || prevStock === undefined || !isFinite(prevStock)) return false;
  var c = observedConsumption_(prevStock, receivedSince, currentStock);
  if (c < 0) return false;                                   // 在庫が増えている＝入荷漏れ／棚卸しズレ
  if (c > prevStock + receivedSince + 1e-9) return false;     // 物理的にありえない
  return true;
}

/**
 * 在庫0で終わったサイクルは「本当はもっと使いたかった」可能性がある（打ち切り観測）。
 * ここで下方修正すると「欠品 → 消費が少なく見える → 発注が減る → また欠品」の
 * 悪循環に入るため、上方修正のみ許可します。
 */
function isCensored_(currentStock) { return currentStock === 0; }

/** EWMA + ウォームアップ + 外れ値ガード */
function learnRate_(prevRate, observedWeekly, n) {
  var base = (prevRate > 0) ? prevRate : observedWeekly;
  var alpha = Math.max(LOGIC_CONST.ALPHA_FLOOR, 1 / (n + 1));
  var next = alpha * observedWeekly + (1 - alpha) * base;
  next = clamp_(next, base * 0.5 - 0.25, base * 2 + 0.25);   // 1回で暴れさせない
  return round2_(clamp_(next, LOGIC_CONST.RATE_MIN, LOGIC_CONST.RATE_MAX));
}

/**
 * 1回分の学習。
 * @param {Object} cfg  { rate, samples, locked, scales }
 * @param {Object} obs  { prevStock, receivedSince, currentStock, days, patientsThen, basePatients }
 * @return {Object} { rate, samples, observedWeekly, normalizedWeekly, adopted, note }
 */
function applyLearning_(cfg, obs) {
  var keep = {
    rate: cfg.rate, samples: cfg.samples,
    observedWeekly: null, normalizedWeekly: null, adopted: false, note: ''
  };
  if (cfg.locked) { keep.note = '手動固定'; return keep; }
  if (!isValidSample_(obs.prevStock, obs.receivedSince, obs.currentStock, obs.days)) {
    keep.note = (obs.days < LOGIC_CONST.LEARN_MIN_DAYS) ? '計測間隔が短い' : 'サンプル棄却';
    return keep;
  }

  var c = observedConsumption_(obs.prevStock, obs.receivedSince, obs.currentStock);
  var observedWeekly = round2_((c / obs.days) * 7);
  var normalized = round2_(normalizeToBase_(observedWeekly, cfg.scales, obs.patientsThen, obs.basePatients));
  keep.observedWeekly = observedWeekly;
  keep.normalizedWeekly = normalized;

  if (isCensored_(obs.currentStock) && normalized <= cfg.rate) {
    keep.note = '在庫0のため下方修正せず';
    return keep;
  }
  return {
    rate: learnRate_(cfg.rate, normalized, cfg.samples),
    samples: cfg.samples + 1,
    observedWeekly: observedWeekly,
    normalizedWeekly: normalized,
    adopted: true,
    note: ''
  };
}

/* ==================================================================
   5. 棚卸
   ================================================================== */

/** 棚卸の差異。プラス＝理論より多い、マイナス＝理論より少ない（紛失・記録漏れ） */
function stocktakeVariance_(theoretical, counted) {
  var diff = counted - theoretical;
  var rate = (theoretical > 0) ? (diff / theoretical) : (counted === 0 ? 0 : null);
  return { diff: round1_(diff), rate: (rate === null ? null : round2_(rate)) };
}

/* ==================================================================
   6. 使用期限
   ------------------------------------------------------------------
   ロット単位では管理せず、「いま棚の手前にある＝次に使うもの」の期限を
   1品目につき1つだけ持ちます。棚卸のときに見て入力する運用です。
   期限切れ廃棄を防ぐ、という目的にはこれで足ります。
   ================================================================== */

/**
 * @param {number|null} expiryDayIndex  使用期限（日インデックス）
 * @param {number} todayDayIndex        今日（日インデックス）
 * @param {number} warnDays             何日前から警告するか
 * @return {{level:string, days:(number|null)}}
 *   level: 'none'（未登録） / 'expired'（切れている） / 'warn'（まもなく） / 'ok'
 *   days : 期限までの残日数。マイナスなら超過日数
 */
function expiryStatus_(expiryDayIndex, todayDayIndex, warnDays) {
  if (expiryDayIndex === null || expiryDayIndex === undefined || !isFinite(expiryDayIndex)) {
    return { level: 'none', days: null };
  }
  var days = expiryDayIndex - todayDayIndex;
  var w = Math.max(0, toNum_(warnDays, 60));
  if (days < 0) return { level: 'expired', days: days };
  if (days <= w) return { level: 'warn', days: days };
  return { level: 'ok', days: days };
}

/** 棚卸が必要か（周期日数を過ぎているか） */
function stocktakeDue_(lastStocktakeDayIndex, todayDayIndex, cycleDays) {
  if (lastStocktakeDayIndex === null || lastStocktakeDayIndex === undefined) {
    return { due: true, elapsed: null, overdue: null };
  }
  var elapsed = todayDayIndex - lastStocktakeDayIndex;
  return { due: elapsed >= cycleDays, elapsed: elapsed, overdue: elapsed - cycleDays };
}
