'use strict';

/**
 * 转速异常定位核心算法（精确分数计算，基于 BigInt）
 *
 * 装置为 1～3 级定轴齿轮传动：轴 1（输入轴）→ … → 轴 n+1（输出轴），
 * 第 i 级理论速比 = 主动轮齿数 / 从动轮齿数（轴 i → 轴 i+1），
 * 任意轴段 (a, b) 的理论速比 = 其间各级速比之积（按齿数精确计算）。
 *
 * 每次观测在同一时段内记录若干轴的转数与绝对误差（至少含首末轴，中间轴可缺测）。
 * 读数 c±ε（要求 ε < c，转数区间不得覆盖 0）换算为该轴转数区间 [c−ε, c+ε]；
 * 轴段 (a, b) 的实测速比区间 = [b下界/a上界, b上界/a下界]（同向转动，均为正）。
 *
 * 故障假设：至多一级 j 存在“跨观测恒定”的倍率偏差——该级实际速比 = 理论值 × k，
 * k 为正常数且在各次观测之间不变，其余各级严格按理论值传动。对每一级 j：
 *   - 不含 j 的观测轴段：理论值必须落在实测区间内（交叉核对）；
 *   - 含 j 的观测轴段：换算倍率区间 = 实测区间 / 理论值，全部（跨观测）求交，
 *     交集非空即得该级的可行倍率区间；
 *   两者同时满足，则“第 j 级异常”与全部观测相容。
 *
 * 结论区分：
 *   - normal       传动正常：全部观测轴段的理论值均落在实测区间内
 *                  （此时各级可行倍率区间均包含正常倍率 1，保留不确定性）；
 *   - suspect      仅一级相容：给出可疑级位及其倍率范围（必不含正常倍率 1）；
 *   - ambiguous    多个级位各自相容：无法区分，不凭首末轴读数指认具体级位；
 *   - inconsistent 没有任何一级相容：与单级恒定偏差假设不符。
 */

const { makeFrac } = require('./search');

const MIN_STAGES = 1;
const MAX_STAGES = 3;
const MIN_OBSERVATIONS = 1;
const MAX_OBSERVATIONS = 10;
const MIN_TEETH = 1;
const MAX_TEETH = 100000;
/** 读数文本的位数上限（防止无意义的天文数字进入 BigInt 运算） */
const MAX_INT_DIGITS = 12;
const MAX_FRAC_DIGITS = 9;

const ONE = { num: 1n, den: 1n };

/** 分数比较：x ≤ y（约分分数，分母为正） */
function fracLeq(x, y) {
  return x.num * y.den <= y.num * x.den;
}

/**
 * 解析观测读数：十进制有限小数（number 或字符串，不接受科学计数法）。
 * 返回约分分数（可为 0 或负数，符号校验由调用方按业务完成）；非法返回 null。
 */
function parseMeasure(raw) {
  let s;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    s = String(raw);
  } else if (typeof raw === 'string') {
    s = raw.trim();
  } else {
    return null;
  }
  if (!s || /[eE]/.test(s)) return null;
  const m = /^([+-]?)(?:(\d+)\.(\d+)|(\d+)\.?|\.(\d+))$/.exec(s);
  if (!m) return null;
  const intPart = m[2] ?? m[4] ?? '';
  const fracPart = m[3] ?? m[5] ?? '';
  if (intPart.length > MAX_INT_DIGITS || fracPart.length > MAX_FRAC_DIGITS) return null;
  const sign = m[1] === '-' ? -1n : 1n;
  const den = 10n ** BigInt(fracPart.length);
  const num = (BigInt(intPart || '0') * den + BigInt(fracPart || '0')) * sign;
  if (num === 0n) return { num: 0n, den: 1n };
  return makeFrac(num, den);
}

/**
 * 校验已装齿轮：1～3 级，每级主动/从动轮齿数均为正整数。
 * @param {*} input
 * @returns {{ok:true, stages:Array<{drive:number,driven:number,ratio:object}>}|{ok:false,error:string}}
 */
function validateStages(input) {
  if (!Array.isArray(input)) {
    return { ok: false, error: `传动级列表格式不正确（需为 ${MIN_STAGES}～${MAX_STAGES} 级的数组）` };
  }
  if (input.length < MIN_STAGES || input.length > MAX_STAGES) {
    return { ok: false, error: `传动级数需为 ${MIN_STAGES}～${MAX_STAGES} 级（当前 ${input.length} 级）` };
  }
  const stages = [];
  for (let i = 0; i < input.length; i++) {
    const row = input[i];
    if (!row || typeof row !== 'object') {
      return { ok: false, error: `第 ${i + 1} 级数据格式不正确` };
    }
    const drive = Number(row.drive);
    const driven = Number(row.driven);
    if (!Number.isInteger(drive) || drive < MIN_TEETH || drive > MAX_TEETH) {
      return { ok: false, error: `第 ${i + 1} 级主动轮齿数需为 ${MIN_TEETH}～${MAX_TEETH} 的整数` };
    }
    if (!Number.isInteger(driven) || driven < MIN_TEETH || driven > MAX_TEETH) {
      return { ok: false, error: `第 ${i + 1} 级从动轮齿数需为 ${MIN_TEETH}～${MAX_TEETH} 的整数` };
    }
    stages.push({ drive, driven, ratio: makeFrac(BigInt(drive), BigInt(driven)) });
  }
  return { ok: true, stages };
}

/**
 * 校验观测记录：1～10 次；每次至少含输入轴（轴 1）与输出轴（轴 n+1）的读数，
 * 中间轴可缺测；同一观测内轴号不得重复；转数为正、绝对误差非负且不覆盖零值。
 * @param {*} input
 * @param {number} stageCount 传动级数（轴数 = 级数 + 1）
 * @returns {{ok:true, observations:Array<{readings:Map<number,{count:object,error:object}>}>}|{ok:false,error:string}}
 */
function validateObservations(input, stageCount) {
  const axisCount = stageCount + 1;
  if (!Array.isArray(input)) {
    return { ok: false, error: '观测记录格式不正确（需为数组）' };
  }
  if (input.length < MIN_OBSERVATIONS || input.length > MAX_OBSERVATIONS) {
    return {
      ok: false,
      error: `观测次数需为 ${MIN_OBSERVATIONS}～${MAX_OBSERVATIONS} 次（当前 ${input.length} 次）`,
    };
  }
  const observations = [];
  for (let i = 0; i < input.length; i++) {
    const row = input[i];
    if (!row || typeof row !== 'object' || !Array.isArray(row.readings)) {
      return { ok: false, error: `第 ${i + 1} 次观测数据格式不正确（需含读数数组 readings）` };
    }
    /** @type {Map<number,{count:object,error:object}>} */
    const readings = new Map();
    for (let j = 0; j < row.readings.length; j++) {
      const rd = row.readings[j];
      if (!rd || typeof rd !== 'object') {
        return { ok: false, error: `第 ${i + 1} 次观测第 ${j + 1} 条读数格式不正确` };
      }
      const axis = Number(rd.axis);
      if (!Number.isInteger(axis) || axis < 1 || axis > axisCount) {
        return { ok: false, error: `第 ${i + 1} 次观测第 ${j + 1} 条读数的轴号需为 1～${axisCount} 的整数` };
      }
      if (readings.has(axis)) {
        return { ok: false, error: `第 ${i + 1} 次观测中轴 ${axis} 的读数重复` };
      }
      const count = parseMeasure(rd.count);
      if (!count || count.num <= 0n) {
        return { ok: false, error: `第 ${i + 1} 次观测轴 ${axis} 的转数需为正数（十进制有限小数）` };
      }
      const error = parseMeasure(rd.error);
      if (!error || error.num < 0n) {
        return { ok: false, error: `第 ${i + 1} 次观测轴 ${axis} 的绝对误差需为非负数（十进制有限小数）` };
      }
      // 误差不得覆盖零值：转数区间下界 count − error 必须严格为正
      const loNum = count.num * error.den - error.num * count.den;
      if (loNum <= 0n) {
        return {
          ok: false,
          error: `第 ${i + 1} 次观测轴 ${axis} 的绝对误差覆盖了零值（误差须小于转数，保证转数区间为正）`,
        };
      }
      readings.set(axis, { count, error });
    }
    if (!readings.has(1) || !readings.has(axisCount)) {
      return {
        ok: false,
        error: `第 ${i + 1} 次观测必须包含输入轴（轴 1）与输出轴（轴 ${axisCount}）的读数`,
      };
    }
    observations.push({ readings });
  }
  return { ok: true, observations };
}

/** 正区间求交（闭区间），交集为空返回 null */
function intersectInterval(a, b) {
  const lo = fracLeq(a.lo, b.lo) ? b.lo : a.lo;
  const hi = fracLeq(a.hi, b.hi) ? a.hi : b.hi;
  return fracLeq(lo, hi) ? { lo, hi } : null;
}

/**
 * 转速异常定位。
 * @param {Array<{drive:number,driven:number,ratio:object}>} stages 已校验的各级齿数（含理论速比）
 * @param {Array<{readings:Map<number,{count:object,error:object}>}>} observations 已校验的观测记录
 */
function diagnose(stages, observations) {
  const stageCount = stages.length;
  const axisCount = stageCount + 1;

  // 前缀积：prefix[a] = 轴 1 → 轴 a+1 的理论速比（0 基下标 a）
  const prefix = [ONE];
  for (let i = 0; i < stageCount; i++) {
    prefix.push(makeFrac(prefix[i].num * stages[i].ratio.num, prefix[i].den * stages[i].ratio.den));
  }
  const segTheoretical = (a, b) =>
    makeFrac(prefix[b].num * prefix[a].den, prefix[b].den * prefix[a].num);

  // 逐次观测：全部观测轴两两组成轴段，把读数误差换算为实测速比区间
  const obsResults = observations.map((obs, oi) => {
    const axes = [...obs.readings.keys()].sort((x, y) => x - y);
    const segments = [];
    for (let x = 0; x < axes.length; x++) {
      for (let y = x + 1; y < axes.length; y++) {
        const from = axes[x];
        const to = axes[y];
        const ra = obs.readings.get(from);
        const rb = obs.readings.get(to);
        // 转数区间 [c−ε, c+ε]（校验已保证下界严格为正）
        const aLo = makeFrac(
          ra.count.num * ra.error.den - ra.error.num * ra.count.den,
          ra.count.den * ra.error.den
        );
        const aHi = makeFrac(
          ra.count.num * ra.error.den + ra.error.num * ra.count.den,
          ra.count.den * ra.error.den
        );
        const bLo = makeFrac(
          rb.count.num * rb.error.den - rb.error.num * rb.count.den,
          rb.count.den * rb.error.den
        );
        const bHi = makeFrac(
          rb.count.num * rb.error.den + rb.error.num * rb.count.den,
          rb.count.den * rb.error.den
        );
        // 实测速比区间 = [b下界/a上界, b上界/a下界]
        const lo = makeFrac(bLo.num * aHi.den, bLo.den * aHi.num);
        const hi = makeFrac(bHi.num * aLo.den, bHi.den * aLo.num);
        const theoretical = segTheoretical(from - 1, to - 1);
        const ok = fracLeq(lo, theoretical) && fracLeq(theoretical, hi);
        segments.push({ from, to, theoretical, lo, hi, ok });
      }
    }
    return { observation: oi + 1, axes, segments };
  });

  // 传动正常假设：全部观测轴段的理论值均落在实测区间内
  const normalConsistent = obsResults.every((o) => o.segments.every((s) => s.ok));

  // 逐级假设：第 j 级（0 基）存在跨观测恒定的倍率偏差
  const candidates = [];
  for (let j = 0; j < stageCount; j++) {
    let interval = null; // 可行倍率区间（全部含级轴段、跨观测的交集；null 表示尚无证据或交集已为空）
    let intervalStarted = false;
    const evidence = []; // 含该级的轴段换算出的倍率区间
    const crossFailures = []; // 不含该级但与理论值不符的轴段（交叉核对未过）
    for (const obs of obsResults) {
      for (const seg of obs.segments) {
        const covers = seg.from - 1 <= j && j < seg.to - 1;
        if (covers) {
          // 倍率区间 = 实测速比区间 / 理论速比
          const mLo = makeFrac(seg.lo.num * seg.theoretical.den, seg.lo.den * seg.theoretical.num);
          const mHi = makeFrac(seg.hi.num * seg.theoretical.den, seg.hi.den * seg.theoretical.num);
          evidence.push({ observation: obs.observation, from: seg.from, to: seg.to, lo: mLo, hi: mHi });
          if (!intervalStarted) {
            interval = { lo: mLo, hi: mHi };
            intervalStarted = true;
          } else if (interval !== null) {
            interval = intersectInterval(interval, { lo: mLo, hi: mHi });
          }
        } else if (!seg.ok) {
          crossFailures.push({
            observation: obs.observation,
            from: seg.from,
            to: seg.to,
            theoretical: seg.theoretical,
            lo: seg.lo,
            hi: seg.hi,
          });
        }
      }
    }
    // 首末轴必测，全链轴段必然覆盖每一级，故 evidence 必然非空
    const feasible = interval !== null && crossFailures.length === 0;
    candidates.push({
      stage: j + 1,
      feasible,
      interval,
      containsNormal:
        interval !== null && fracLeq(interval.lo, ONE) && fracLeq(ONE, interval.hi),
      evidence,
      crossFailures,
    });
  }

  const suspectStages = candidates.filter((c) => c.feasible).map((c) => c.stage);
  const totalSegments = obsResults.reduce((n, o) => n + o.segments.length, 0);

  let verdict;
  let message;
  if (normalConsistent) {
    verdict = 'normal';
    message =
      `传动正常：全部 ${totalSegments} 个观测轴段的理论速比均落在实测区间内，未发现异常。` +
      '各级假设下的可行倍率区间均包含正常倍率 1，保留不确定性。';
  } else if (suspectStages.length === 1) {
    verdict = 'suspect';
    message =
      `可疑级位：第 ${suspectStages[0]} 级。在“至多一级存在跨观测恒定倍率偏差”的假设下，` +
      `仅第 ${suspectStages[0]} 级与全部观测相容，其可行倍率区间不含正常倍率 1。`;
    if (observations.length === 1) {
      message += '注意：仅有 1 次观测，无法验证倍率的跨观测恒定性，建议增加观测次数复核。';
    }
  } else if (suspectStages.length > 1) {
    verdict = 'ambiguous';
    message =
      `多个级位无法区分：第 ${suspectStages.join('、')} 级各自均与全部观测相容` +
      '（可行倍率区间均不含正常倍率 1）。现有观测轴段不足以区分这些级位——' +
      '不凭首末轴读数指认具体级位，请补充中间轴读数或增加观测次数。';
  } else {
    verdict = 'inconsistent';
    message =
      '与单级恒定偏差假设不符：任何一级作为唯一异常级都无法同时满足全部观测（见逐级假设核对）。' +
      '可能是多级同时异常、偏差随工况变化或读数登记有误，请复核读数后重试，或改用其他诊断方式。';
  }

  return {
    stageCount,
    axisCount,
    observationCount: observations.length,
    totalSegments,
    verdict,
    message,
    normalConsistent,
    suspectStages,
    totalRatio: prefix[stageCount],
    observations: obsResults,
    candidates,
  };
}

module.exports = {
  MIN_STAGES,
  MAX_STAGES,
  MIN_OBSERVATIONS,
  MAX_OBSERVATIONS,
  MIN_TEETH,
  MAX_TEETH,
  parseMeasure,
  validateStages,
  validateObservations,
  diagnose,
};
