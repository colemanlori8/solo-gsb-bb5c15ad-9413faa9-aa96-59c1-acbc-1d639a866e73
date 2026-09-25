'use strict';

const path = require('path');
const express = require('express');
const {
  search,
  parseTarget,
  parseTolerance,
  validateGears,
  MAX_STAGES,
  MAX_GEARS,
} = require('./search');
const { planBatch } = require('./batch');
const {
  planProcure,
  validateBuyableGears,
  MIN_EXISTING,
  MAX_EXISTING,
  MAX_TOTAL_GEARS,
} = require('./procure');
const { planDualSpeed, MIN_GEARS: MIN_DUAL_GEARS } = require('./dual');
const { planTorque, validateTorqueGears, parsePositiveInt, MAX_TORQUE } = require('./torque');
const {
  planLayout,
  parseAxes,
  parseModule,
  MIN_AXES,
  MAX_AXES,
  MAX_MODULE,
} = require('./layout');
const { validateDiagnoseInput, diagnose, MAX_OBSERVATIONS } = require('./diagnose');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/** 友好访问批量装配页：/batch → /batch.html */
app.get('/batch', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'batch.html'));
});

/** 友好访问缺齿补货采购建议页：/procure → /procure.html */
app.get('/procure', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'procure.html'));
});

/** 友好访问双档换速页：/dual-speed → /dual-speed.html */
app.get('/dual-speed', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dual-speed.html'));
});

/** 友好访问带载安全选配页：/torque → /torque.html */
app.get('/torque', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'torque.html'));
});

/** 友好访问轴位装配页：/layout → /layout.html */
app.get('/layout', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'layout.html'));
});

/** 友好访问转速异常定位页：/diagnose → /diagnose.html */
app.get('/diagnose', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'diagnose.html'));
});

/** BigInt 分数安全转为有限小数（用于前端展示） */
function fracToDecimal(frac, digits = 10) {
  const neg = frac.num < 0n;
  let num = frac.num < 0n ? -frac.num : frac.num;
  const intPart = num / frac.den;
  let rem = num % frac.den;
  let out = intPart.toString();
  if (digits > 0) {
    let fracStr = '';
    for (let i = 0; i < digits && rem > 0n; i++) {
      rem *= 10n;
      fracStr += (rem / frac.den).toString();
      rem %= frac.den;
    }
    if (fracStr) out += `.${fracStr}`;
  }
  return neg ? `-${out}` : out;
}

function serializeFrac(f) {
  return { num: f.num.toString(), den: f.den.toString(), decimal: fracToDecimal(f) };
}

function serializeSolution(r) {
  return {
    stages: r.stages,
    ratio: serializeFrac(r.ratio),
    error: serializeFrac(r.error),
    errorPercent: fracToDecimal({ num: r.error.num * 100n, den: r.error.den }, 6),
    pairs: r.pairs.map((p) => ({
      drive: p.drive,
      driven: p.driven,
      stageRatio: serializeFrac(p.stageRatio),
    })),
  };
}

/** 带载方案：每级两轮的承受扭矩（分数 + 小数）与正整数额定扭矩一并序列化 */
function serializeTorqueGear(g) {
  return {
    id: g.id,
    teeth: g.teeth,
    ratedTorque: g.ratedTorque,
    torque: serializeFrac(g.torque),
    atLimit: g.torque.num === BigInt(g.ratedTorque) * g.torque.den,
  };
}

function serializeTorqueSolution(r) {
  return {
    stages: r.stages,
    ratio: serializeFrac(r.ratio),
    error: serializeFrac(r.error),
    errorPercent: fracToDecimal({ num: r.error.num * 100n, den: r.error.den }, 6),
    pairs: r.pairs.map((p) => ({
      inputTorque: serializeFrac(p.inputTorque),
      drive: serializeTorqueGear(p.drive),
      driven: serializeTorqueGear(p.driven),
      stageRatio: serializeFrac(p.stageRatio),
    })),
  };
}

/** 轴位装配：逐轴安装的单个齿轮位（含同轴固定的角色说明） */
function serializeShaftMount(m) {
  return {
    stage: m.stage,
    role: m.role,
    gear: { id: m.gear.id, teeth: m.gear.teeth },
  };
}

/** 轴位装配方案：逐级啮合明细 + 逐轴安装明细 */
function serializeLayoutSolution(r) {
  return {
    stages: r.stages,
    ratio: serializeFrac(r.ratio),
    error: serializeFrac(r.error),
    errorPercent: fracToDecimal({ num: r.error.num * 100n, den: r.error.den }, 6),
    pairs: r.pairs.map((p) => ({
      stage: p.stage,
      fromAxis: p.fromAxis,
      toAxis: p.toAxis,
      dx: p.dx,
      dy: p.dy,
      axisDistance: p.axisDistance,
      requiredTeethSum: p.requiredTeethSum,
      drive: p.drive,
      driven: p.driven,
      stageRatio: serializeFrac(p.stageRatio),
    })),
    shafts: r.shafts.map((s) => ({
      axis: s.axis,
      x: s.x,
      y: s.y,
      mounts: s.mounts.map(serializeShaftMount),
    })),
    unusedGears: r.unusedGears,
  };
}

/**
 * 校验装置/档位参数列表（目标速比 / 容差 / 名称）。
 * @param {*} input
 * @param {{min?:number,max?:number,unit?:string,defaultNamePrefix?:string}} [opts]
 * @returns {{ok:true,devices:Array}|{ok:false,status?:number,error:string}}
 */
function parseDevices(input, { min = 2, max = 3, unit = '台装置', defaultNamePrefix = '装置' } = {}) {
  if (!Array.isArray(input) || input.length < min || input.length > max) {
    return { ok: false, error: `需输入 ${min}${min === max ? '' : `～${max}`} ${unit}` };
  }
  const devices = [];
  for (let i = 0; i < input.length; i++) {
    const row = input[i];
    if (!row || typeof row !== 'object') {
      return { ok: false, error: `第 ${i + 1} ${unit}数据格式不正确` };
    }
    const target = parseTarget(String(row.target ?? ''));
    if (!target) {
      return {
        ok: false,
        error: `第 ${i + 1} ${unit}的目标输出转速比格式不正确：请输入正数（如 0.0833、1/12）`,
      };
    }
    const tolerance = parseTolerance(String(row.tolerance ?? ''));
    if (!tolerance) {
      return {
        ok: false,
        error: `第 ${i + 1} ${unit}的允许相对误差格式不正确：请输入非负数（如 0.05 或 5%）`,
      };
    }
    const name = String(row.name ?? '').trim() || `${defaultNamePrefix} ${i + 1}`;
    if (name.length > 30) {
      return { ok: false, error: `第 ${i + 1} ${unit}名称不能超过 30 个字符` };
    }
    devices.push({ name, target, tolerance });
  }
  return { ok: true, devices };
}

app.post('/api/search', (req, res) => {
  const body = req.body || {};

  const target = parseTarget(String(body.target ?? ''));
  if (!target) {
    return res.status(400).json({ error: '目标输出转速比格式不正确：请输入正数（如 0.0833、1/12）' });
  }

  const tolerance = parseTolerance(String(body.tolerance ?? ''));
  if (!tolerance) {
    return res.status(400).json({ error: '允许相对误差格式不正确：请输入非负数（如 0.05 或 5%）' });
  }

  const checked = validateGears(body.gears);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  const { total, truncated, results } = search(checked.gears, target, tolerance);

  res.json({
    target: serializeFrac(target),
    tolerance: serializeFrac(tolerance),
    maxStages: MAX_STAGES,
    total,
    truncated,
    count: results.length,
    results: results.map(serializeSolution),
  });
});

app.post('/api/batch', (req, res) => {
  const body = req.body || {};

  const checked = validateGears(body.gears);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  const parsed = parseDevices(body.devices, { min: 2, max: 3 });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const devices = parsed.devices;

  // 基于全部达标方案分配（不截断 300 条）
  const plan = planBatch(checked.gears, devices);

  const usedIds = new Set();
  for (const pick of plan.picks) {
    if (pick) for (const id of pick.gearIds) usedIds.add(id);
  }
  const unusedGears = checked.gears.filter((g) => !usedIds.has(g.id));

  res.json({
    maxStages: MAX_STAGES,
    deviceCount: devices.length,
    matchedCount: plan.matchedCount,
    totalStages: plan.totalStages,
    errorSum: serializeFrac(plan.errorSum),
    errorSumPercent: fracToDecimal({ num: plan.errorSum.num * 100n, den: plan.errorSum.den }, 6),
    unusedGears,
    devices: devices.map((d, i) => ({
      name: d.name,
      target: serializeFrac(d.target),
      tolerance: serializeFrac(d.tolerance),
      totalMatches: plan.totalMatches[i],
      candidateCount: plan.candidateCounts[i],
      matched: !!plan.picks[i],
      solution: plan.picks[i] ? serializeSolution(plan.picks[i]) : null,
    })),
  });
});

app.post('/api/procure', (req, res) => {
  const body = req.body || {};

  // 现有齿轮：2～8 枚
  const existingChecked = validateGears(body.existingGears, {
    label: '现有齿轮',
    min: MIN_EXISTING,
    max: MAX_EXISTING,
  });
  if (!existingChecked.ok) return res.status(400).json({ error: existingChecked.error });

  // 可购实物齿轮：1～4 枚，带非负整数价格
  const buyableChecked = validateBuyableGears(body.buyableGears);
  if (!buyableChecked.ok) return res.status(400).json({ error: buyableChecked.error });

  // 跨列表编号不得重复；合计不超过 12 枚
  const existingIds = new Set(existingChecked.gears.map((g) => g.id));
  for (const g of buyableChecked.gears) {
    if (existingIds.has(g.id)) {
      return res.status(400).json({ error: `现有齿轮与可购齿轮编号重复：${g.id}` });
    }
  }
  const totalGearCount = existingChecked.gears.length + buyableChecked.gears.length;
  if (totalGearCount > MAX_TOTAL_GEARS) {
    return res.status(400).json({
      error: `现有齿轮与可购齿轮合计不能超过 ${MAX_TOTAL_GEARS} 枚（当前 ${totalGearCount} 枚）`,
    });
  }

  // 固定 2 台装置（各自速比与容差）
  const parsed = parseDevices(body.devices, { min: 2, max: 2 });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const devices = parsed.devices;

  const result = planProcure(existingChecked.gears, buyableChecked.gears, devices);

  const base = {
    maxStages: MAX_STAGES,
    deviceCount: result.deviceCount,
    subsetsChecked: result.subsetsChecked,
    feasibleSubsets: result.feasibleSubsets,
    devices: devices.map((d, i) => ({
      name: d.name,
      target: serializeFrac(d.target),
      tolerance: serializeFrac(d.tolerance),
      hasMatchInPool: result.deviceHasMatch[i],
    })),
    existingGears: existingChecked.gears,
    buyableGears: buyableChecked.gears,
  };

  if (!result.feasible) {
    return res.json({
      ...base,
      feasible: false,
      purchaseCount: 0,
      totalPrice: 0,
      purchasedGears: [],
      unusedGears: [],
      message:
        '枚举全部可购齿轮子集后，两台装置仍无法在齿轮不复用的前提下同时达标装配。' +
        '请考虑增加可购齿轮、放宽容差或调整目标速比。',
    });
  }

  res.json({
    ...base,
    feasible: true,
    noPurchaseNeeded: result.noPurchaseNeeded,
    purchaseCount: result.purchaseCount,
    totalPrice: result.totalPrice,
    totalStages: result.totalStages,
    errorSum: serializeFrac(result.errorSum),
    errorSumPercent: fracToDecimal({ num: result.errorSum.num * 100n, den: result.errorSum.den }, 6),
    purchasedGears: result.purchasedGears,
    unusedGears: result.unusedGears,
    devices: base.devices.map((d, i) => ({
      ...d,
      solution: serializeSolution(result.picks[i]),
    })),
  });
});

app.post('/api/dual-speed', (req, res) => {
  const body = req.body || {};

  // 齿轮：4～12 枚（固定级 2 枚 + 每档换装级 2 枚），沿用现有输入校验
  const checked = validateGears(body.gears, {
    label: '齿轮',
    min: MIN_DUAL_GEARS,
    max: MAX_GEARS,
  });
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  // 固定 2 个档位（各自目标速比与容差）
  const parsed = parseDevices(body.speeds, {
    min: 2,
    max: 2,
    unit: '个档位',
    defaultNamePrefix: '档位',
  });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const speeds = parsed.devices;

  // 基于完整候选枚举分配（不截断）：需更换轴位最少 → 误差之和最小 → 编号自然序
  const result = planDualSpeed(checked.gears, speeds);

  const base = {
    gearCount: checked.gears.length,
    candidateCount: result.candidateCount,
    speeds: speeds.map((sp, i) => ({
      name: sp.name,
      target: serializeFrac(sp.target),
      tolerance: serializeFrac(sp.tolerance),
      hasCandidate: result.hasCandidate[i],
    })),
  };

  if (!result.feasible) {
    return res.json({
      ...base,
      feasible: false,
      changeCount: null,
      changedPositions: [],
      fixedStage: null,
      errorSum: null,
      message:
        '未找到满足条件的双档装配方案：两个档位必须共用同一个有向齿轮对作为固定第一级，' +
        '且每档恰好两级、档内 4 枚齿轮不得复用。可尝试放宽容差、调整目标速比或增加齿轮。',
    });
  }

  // 级内分数（BigInt）统一序列化
  const serStage = (st) => ({
    drive: st.drive,
    driven: st.driven,
    stageRatio: serializeFrac(st.stageRatio),
  });
  const fixedStage = serStage(result.fixedStage);

  res.json({
    ...base,
    feasible: true,
    fixedStage,
    changeCount: result.changeCount,
    changedPositions: result.changedPositions,
    errorSum: serializeFrac(result.errorSum),
    errorSumPercent: fracToDecimal({ num: result.errorSum.num * 100n, den: result.errorSum.den }, 6),
    speeds: base.speeds.map((sp, i) => {
      const plan = result.speeds[i];
      return {
        ...sp,
        solution: {
          stages: 2,
          ratio: serializeFrac(plan.ratio),
          error: serializeFrac(plan.error),
          errorPercent: fracToDecimal({ num: plan.error.num * 100n, den: plan.error.den }, 6),
          pairs: [fixedStage, serStage(plan.swapStage)],
        },
      };
    }),
  });
});

app.post('/api/torque', (req, res) => {
  const body = req.body || {};

  const target = parseTarget(String(body.target ?? ''));
  if (!target) {
    return res.status(400).json({ error: '目标输出转速比格式不正确：请输入正数（如 0.0833、1/12）' });
  }

  const tolerance = parseTolerance(String(body.tolerance ?? ''));
  if (!tolerance) {
    return res.status(400).json({ error: '允许相对误差格式不正确：请输入非负数（如 0.05 或 5%）' });
  }

  const checkedTorque = parsePositiveInt(body.inputTorque, '输入扭矩');
  if (!checkedTorque.ok) return res.status(400).json({ error: checkedTorque.error });
  const inputTorque = BigInt(checkedTorque.value);

  const checked = validateTorqueGears(body.gears);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  // 完整枚举速比配对组后，对每组配对的全部级次顺序分别做扭矩校核（不截断）
  const plan = planTorque(checked.gears, target, tolerance, inputTorque);

  const base = {
    target: serializeFrac(target),
    tolerance: serializeFrac(tolerance),
    maxStages: MAX_STAGES,
    inputTorque: checkedTorque.value,
    maxTorque: MAX_TORQUE,
    ratioMatchCount: plan.ratioMatchCount,
    loadCandidatesChecked: plan.loadCandidatesChecked,
  };

  // 区分“速比无解”与“速比有解但全部超载”
  if (plan.ratioMatchCount === 0) {
    return res.json({
      ...base,
      feasible: false,
      reason: 'ratio',
      total: 0,
      truncated: false,
      count: 0,
      results: [],
      message:
        '速比无解：在 1～3 级传动、每枚齿轮至多使用一次的限制下，' +
        '所有组合的实际转速比相对误差均超出允许范围，未进入扭矩校核。' +
        '可尝试放宽误差、调整目标速比或增加齿轮。',
    });
  }

  if (plan.total === 0) {
    return res.json({
      ...base,
      feasible: false,
      reason: 'overload',
      total: 0,
      truncated: false,
      count: 0,
      results: [],
      message:
        `全部超载：共有 ${plan.ratioMatchCount} 组速比达标的配对，其全部 ${plan.loadCandidatesChecked} 种级次顺序` +
        '（同一组配对的各级排列已分别校核）都至少有一枚齿轮的承受扭矩超过其额定值。' +
        '可尝试降低输入扭矩、提高相关齿轮的额定扭矩或增加可选齿轮。',
    });
  }

  res.json({
    ...base,
    feasible: true,
    reason: 'ok',
    total: plan.total,
    truncated: plan.truncated,
    count: plan.results.length,
    results: plan.results.map(serializeTorqueSolution),
  });
});

app.post('/api/layout', (req, res) => {
  const body = req.body || {};

  // 轴心：2～4 个沿直线依次排列的整数坐标点
  const axesChecked = parseAxes(body.axes);
  if (!axesChecked.ok) return res.status(400).json({ error: axesChecked.error });
  const axes = axesChecked.axes;

  // 模数：统一正整数
  const moduleChecked = parseModule(body.module);
  if (!moduleChecked.ok) return res.status(400).json({ error: moduleChecked.error });
  const mod = moduleChecked.value;

  const target = parseTarget(String(body.target ?? ''));
  if (!target) {
    return res.status(400).json({ error: '目标输出转速比格式不正确：请输入正数（如 0.0833、1/12）' });
  }

  const tolerance = parseTolerance(String(body.tolerance ?? ''));
  if (!tolerance) {
    return res.status(400).json({ error: '允许相对误差格式不正确：请输入非负数（如 0.05 或 5%）' });
  }

  // 现有齿轮：2～12 枚，沿用统一校验；轴数 n 需要恰好 2(n-1) 枚不同实物
  const stageCount = axes.length - 1;
  const minGears = 2 * stageCount;
  const checked = validateGears(body.gears, { label: '齿轮', min: 2, max: MAX_GEARS });
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  if (checked.gears.length < minGears) {
    return res.status(400).json({
      error: `${axes.length} 个轴共 ${stageCount} 级传动，至少需要 ${minGears} 枚齿轮（当前 ${checked.gears.length} 枚）`,
    });
  }

  // 穷举每级满足 2×轴距=模数×(主+从) 的有向配对并跨级组合，精确分数校核总速比
  const plan = planLayout(checked.gears, axes, mod, target, tolerance);

  const geometryStages = plan.stages.map((st) => {
    let meshingReason;
    if (st.distance === null) {
      meshingReason = '轴距不是整数，整数模数与整数齿数无法满足 2×轴距=模数×齿数和';
    } else if (st.requiredSum === null) {
      meshingReason = `2×轴距=${2 * st.distance} 不能被模数 ${mod} 整除（或齿数和 < 2），无整数齿数解`;
    }
    return {
      stage: st.stage,
      dx: st.dx,
      dy: st.dy,
      distanceSquared: st.dx * st.dx + st.dy * st.dy,
      distance: st.distance,
      requiredTeethSum: st.requiredSum,
      meshingPossible: st.requiredSum !== null,
      meshingReason,
      candidateCount: plan.candidateCounts[st.stage - 1],
    };
  });

  const base = {
    axes,
    module: mod,
    stageCount,
    target: serializeFrac(target),
    tolerance: serializeFrac(tolerance),
    stages: geometryStages,
    gearCount: checked.gears.length,
    assemblyCount: plan.assemblyCount,
  };

  // 第一类无解：几何/齿数层面就不存在完整可啮合装配
  const impossibleStage = geometryStages.find((st) => !st.meshingPossible);
  if (impossibleStage) {
    return res.json({
      ...base,
      feasible: false,
      reason: 'meshing',
      total: 0,
      best: null,
      message:
        `无可啮合装配：第 ${impossibleStage.stage} 级（第 ${impossibleStage.stage}～${impossibleStage.stage + 1} 轴）` +
        `${impossibleStage.meshingReason}。请调整轴心坐标或模数。`,
    });
  }

  const emptyStage = geometryStages.find((st) => st.candidateCount === 0);
  if (emptyStage) {
    return res.json({
      ...base,
      feasible: false,
      reason: 'meshing',
      total: 0,
      best: null,
      message:
        `无可啮合装配：第 ${emptyStage.stage} 级（第 ${emptyStage.stage}～${emptyStage.stage + 1} 轴）要求主动齿数 + 从动齿数 = ` +
        `${emptyStage.requiredTeethSum}，但现有齿轮中不存在满足该齿数和的两枚齿轮。` +
        '请补充齿数互补的齿轮，或调整轴位 / 模数。',
    });
  }

  if (plan.assemblyCount === 0) {
    return res.json({
      ...base,
      feasible: false,
      reason: 'meshing',
      total: 0,
      best: null,
      message:
        '无可啮合装配：虽然每级各自存在满足轴距的齿轮对，但跨级组合无法做到每枚齿轮全程只用一次。' +
        '请增加齿轮（补足齿数互补的型号）或调整轴位、模数。',
    });
  }

  // 第二类无解：存在完整可啮合装配，但全部速比相对误差超出容差
  if (plan.total === 0) {
    return res.json({
      ...base,
      feasible: false,
      reason: 'ratio',
      total: 0,
      best: null,
      closest: serializeLayoutSolution(plan.closest),
      message:
        `可装配但速比不达标：共枚举 ${plan.assemblyCount} 种满足全部轴距的完整装配，` +
        '其实际总速比的相对误差均超出允许范围。下列为误差最小的一种（不达标，仅供参考）；' +
        '可尝试放宽容差、调整目标速比、轴位 / 模数或更换齿轮。',
    });
  }

  res.json({
    ...base,
    feasible: true,
    reason: 'ok',
    total: plan.total,
    best: serializeLayoutSolution(plan.best),
  });
});

app.post('/api/diagnose', (req, res) => {
  const body = req.body || {};

  const checked = validateDiagnoseInput(body);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  const { stages, observations } = checked;

  // 按齿数精确计算理论速比；读数误差区间转为实测速比区间；逐级求恒定倍率可行区间
  const result = diagnose(stages, observations);

  res.json({
    stageCount: result.stageCount,
    axisCount: result.axisCount,
    observationCount: result.observationCount,
    maxObservations: MAX_OBSERVATIONS,
    stages: result.stages.map((st) => ({
      stage: st.stage,
      driveTeeth: st.driveTeeth,
      drivenTeeth: st.drivenTeeth,
      stageRatio: serializeFrac(result.stageRatios[st.stage - 1]),
    })),
    shaftRatios: result.shaftRatios.map(serializeFrac),
    observations: result.observations.map((ob, oi) => ({
      name: ob.name || `观测 ${oi + 1}`,
      axes: ob.axes,
      readings: ob.readings.map((rd) => ({
        axis: rd.axis,
        revolutions: serializeFrac(rd.revolutions),
        error: serializeFrac(rd.error),
      })),
      segments: ob.segments.map((s) => ({
        fromAxis: s.fromAxis,
        toAxis: s.toAxis,
        low: serializeFrac(s.low),
        high: serializeFrac(s.high),
        theory: serializeFrac(s.theory),
        normal: s.normal,
      })),
    })),
    verdict: result.verdict,
    normal: result.normal,
    endAxesOnly: result.endAxesOnly,
    abnormalSegments: result.abnormalSegments,
    candidates: result.candidates.map((c) => ({
      stage: c.stage,
      feasible: c.feasible,
      intersectionNonEmpty: c.intersectionNonEmpty,
      factorLow: serializeFrac(c.factorLow),
      factorHigh: serializeFrac(c.factorHigh),
      containsUnity: c.containsUnity,
      direction: c.direction,
      crossCheckFailed: c.crossCheckFailed,
    })),
    feasibleStages: result.feasibleStages,
    suspectStage: result.suspectStage,
    message: result.message,
  });
});

app.listen(PORT, () => {
  console.log(`齿轮组选配服务已启动： http://localhost:${PORT}`);
  console.log(`  单台选配： http://localhost:${PORT}/`);
  console.log(`  批量装配： http://localhost:${PORT}/batch`);
  console.log(`  缺齿补货： http://localhost:${PORT}/procure`);
  console.log(`  双档换速： http://localhost:${PORT}/dual-speed`);
  console.log(`  带载安全： http://localhost:${PORT}/torque`);
  console.log(`  轴位装配： http://localhost:${PORT}/layout`);
  console.log(`  转速异常定位： http://localhost:${PORT}/diagnose`);
});
