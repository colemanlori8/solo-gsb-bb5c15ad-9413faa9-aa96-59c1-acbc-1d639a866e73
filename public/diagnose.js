'use strict';

const MIN_STAGES = 1;
const MAX_STAGES = 3;
const MIN_OBS = 1;
const MAX_OBS = 10;
const MIN_TEETH = 1;
const MAX_TEETH = 100000;

const stageRowsBox = document.getElementById('stage-rows');
const obsListBox = document.getElementById('obs-list');
const form = document.getElementById('diagnose-form');
const formError = document.getElementById('form-error');
const resultPanel = document.getElementById('result-panel');
const resultSummary = document.getElementById('result-summary');
const verdictBanner = document.getElementById('verdict-banner');
const theoryPanel = document.getElementById('theory-panel');
const obsPanels = document.getElementById('obs-panels');
const candidatePanel = document.getElementById('candidate-panel');

/* 示例：两级 1/3 × 1/3 = 1/9，第 2 级存在 ≈1.2 倍恒定偏差；第 3 次观测缺中间轴 */
const EXAMPLE_STAGES = [
  { drive: 12, driven: 36 },
  { drive: 15, driven: 45 },
];
const EXAMPLE_OBSERVATIONS = [
  {
    readings: [
      { axis: 1, count: '360', error: '3' },
      { axis: 2, count: '120', error: '1' },
      { axis: 3, count: '48', error: '0.5' },
    ],
  },
  {
    readings: [
      { axis: 1, count: '180', error: '2' },
      { axis: 2, count: '60', error: '1' },
      { axis: 3, count: '24', error: '0.5' },
    ],
  },
  {
    readings: [
      { axis: 1, count: '540', error: '4' },
      { axis: 3, count: '72', error: '0.6' },
    ],
  },
];

const VERDICT_META = {
  normal: { cls: 'ok', label: '传动正常' },
  suspect: { cls: 'warn', label: '可疑级位' },
  ambiguous: { cls: 'warn', label: '多个级位无法区分' },
  inconsistent: { cls: 'error', label: '与单级恒定偏差假设不符' },
};

function el(tag, className, html) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function stageCount() {
  return stageRowsBox.children.length;
}

function axisLabel(axis, axisCount) {
  if (axis === 1) return `轴 1（输入轴）`;
  if (axis === axisCount) return `轴 ${axis}（输出轴）`;
  return `轴 ${axis}（中间轴）`;
}

/* ---------------- 级（齿数）行 ---------------- */

function addStageRow(drive = '', driven = '') {
  const row = el('div', 'stage-row');
  row.innerHTML = `
    <span class="stage-index"></span>
    <input class="stage-drive" type="number" min="${MIN_TEETH}" max="${MAX_TEETH}" step="1" placeholder="主动轮齿数" value="${drive}" />
    <input class="stage-driven" type="number" min="${MIN_TEETH}" max="${MAX_TEETH}" step="1" placeholder="从动轮齿数" value="${driven}" />
    <button type="button" class="btn danger-ghost" title="删除该级">✕</button>`;
  row.querySelector('button').addEventListener('click', () => {
    if (stageCount() <= MIN_STAGES) {
      alert(`至少保留 ${MIN_STAGES} 级传动`);
      return;
    }
    row.remove();
    refreshStageIndex();
    refreshAxisSelects();
  });
  stageRowsBox.appendChild(row);
  refreshStageIndex();
  refreshAxisSelects();
}

function refreshStageIndex() {
  [...stageRowsBox.children].forEach((row, i) => {
    row.querySelector('.stage-index').textContent = `第 ${i + 1} 级（轴 ${i + 1} → 轴 ${i + 2}）`;
  });
}

document.getElementById('btn-stage-add').addEventListener('click', () => {
  if (stageCount() >= MAX_STAGES) {
    alert(`最多 ${MAX_STAGES} 级传动`);
    return;
  }
  addStageRow();
});

/* ---------------- 观测与读数行 ---------------- */

/** 级数变化后，重建所有轴下拉项（保留仍有效的选择） */
function refreshAxisSelects() {
  const axisCount = stageCount() + 1;
  document.querySelectorAll('.reading-axis').forEach((sel) => {
    const prev = Number(sel.value);
    sel.innerHTML = '';
    for (let a = 1; a <= axisCount; a++) {
      const opt = document.createElement('option');
      opt.value = String(a);
      opt.textContent = axisLabel(a, axisCount);
      sel.appendChild(opt);
    }
    sel.value = String(prev >= 1 && prev <= axisCount ? prev : 1);
  });
}

function addReadingRow(rowsBox, axis = 1, count = '', error = '') {
  const row = el('div', 'reading-row');
  row.innerHTML = `
    <select class="reading-axis"></select>
    <input class="reading-count" type="text" inputmode="decimal" placeholder="如 360" value="${count}" />
    <input class="reading-error" type="text" inputmode="decimal" placeholder="如 3" value="${error}" />
    <button type="button" class="btn danger-ghost" title="删除该读数">✕</button>`;
  row.querySelector('button').addEventListener('click', () => {
    if (rowsBox.children.length <= 2) {
      alert('每次观测至少保留 2 条读数（输入轴与输出轴）');
      return;
    }
    row.remove();
  });
  rowsBox.appendChild(row);

  const sel = row.querySelector('.reading-axis');
  const axisCount = stageCount() + 1;
  for (let a = 1; a <= axisCount; a++) {
    const opt = document.createElement('option');
    opt.value = String(a);
    opt.textContent = axisLabel(a, axisCount);
    sel.appendChild(opt);
  }
  sel.value = String(Math.min(axis, axisCount));
}

function addObservation(readings) {
  const block = el('div', 'obs-block');
  block.innerHTML = `
    <div class="obs-head">
      <span class="obs-title"></span>
      <div class="btn-row">
        <button type="button" class="btn ghost obs-add-reading">＋ 添加读数</button>
        <button type="button" class="btn danger-ghost obs-del">✕ 删除观测</button>
      </div>
    </div>
    <div class="reading-grid-head">
      <span>轴</span><span>转数（正数）</span><span>绝对误差（≥0，&lt;转数）</span><span></span>
    </div>
    <div class="reading-rows"></div>`;
  const rowsBox = block.querySelector('.reading-rows');

  block.querySelector('.obs-add-reading').addEventListener('click', () => {
    if (rowsBox.children.length >= stageCount() + 1) {
      alert('每个轴至多一条读数（已是全部轴）');
      return;
    }
    addReadingRow(rowsBox);
  });
  block.querySelector('.obs-del').addEventListener('click', () => {
    if (obsListBox.children.length <= MIN_OBS) {
      alert(`至少保留 ${MIN_OBS} 次观测`);
      return;
    }
    block.remove();
    refreshObsIndex();
  });

  obsListBox.appendChild(block);
  const list = readings && readings.length
    ? readings
    : [{ axis: 1, count: '', error: '' }, { axis: stageCount() + 1, count: '', error: '' }];
  list.forEach((r) => addReadingRow(rowsBox, r.axis, r.count, r.error));
  refreshObsIndex();
}

function refreshObsIndex() {
  [...obsListBox.children].forEach((block, i) => {
    block.querySelector('.obs-title').textContent = `观测 ${i + 1}（同一时段各轴读数）`;
  });
}

document.getElementById('btn-obs-add').addEventListener('click', () => {
  if (obsListBox.children.length >= MAX_OBS) {
    alert(`最多 ${MAX_OBS} 次观测`);
    return;
  }
  addObservation();
});

document.getElementById('btn-example').addEventListener('click', () => {
  stageRowsBox.innerHTML = '';
  EXAMPLE_STAGES.forEach((s) => addStageRow(s.drive, s.driven));
  obsListBox.innerHTML = '';
  EXAMPLE_OBSERVATIONS.forEach((o) => addObservation(o.readings));
});

/* 初始：示例数据 */
EXAMPLE_STAGES.forEach((s) => addStageRow(s.drive, s.driven));
EXAMPLE_OBSERVATIONS.forEach((o) => addObservation(o.readings));

/* ---------------- 采集与前端预校验 ---------------- */

function collectStages() {
  const rows = [...stageRowsBox.querySelectorAll('.stage-row')];
  if (rows.length < MIN_STAGES || rows.length > MAX_STAGES) {
    throw new Error(`传动级数需为 ${MIN_STAGES}～${MAX_STAGES} 级`);
  }
  return rows.map((row, i) => {
    const drive = Number(row.querySelector('.stage-drive').value.trim());
    const driven = Number(row.querySelector('.stage-driven').value.trim());
    if (!Number.isInteger(drive) || drive < MIN_TEETH || drive > MAX_TEETH) {
      throw new Error(`第 ${i + 1} 级主动轮齿数需为 ${MIN_TEETH}～${MAX_TEETH} 的整数`);
    }
    if (!Number.isInteger(driven) || driven < MIN_TEETH || driven > MAX_TEETH) {
      throw new Error(`第 ${i + 1} 级从动轮齿数需为 ${MIN_TEETH}～${MAX_TEETH} 的整数`);
    }
    return { drive, driven };
  });
}

function collectObservations(axisCount) {
  const blocks = [...obsListBox.querySelectorAll('.obs-block')];
  if (blocks.length < MIN_OBS || blocks.length > MAX_OBS) {
    throw new Error(`观测次数需为 ${MIN_OBS}～${MAX_OBS} 次`);
  }
  return blocks.map((block, i) => {
    const seen = new Set();
    const readings = [...block.querySelectorAll('.reading-row')].map((row) => {
      const axis = Number(row.querySelector('.reading-axis').value);
      if (seen.has(axis)) throw new Error(`第 ${i + 1} 次观测中轴 ${axis} 的读数重复`);
      seen.add(axis);
      const count = row.querySelector('.reading-count').value.trim();
      const error = row.querySelector('.reading-error').value.trim();
      if (!count) throw new Error(`第 ${i + 1} 次观测轴 ${axis} 缺少转数`);
      if (!error) throw new Error(`第 ${i + 1} 次观测轴 ${axis} 缺少绝对误差`);
      return { axis, count, error };
    });
    if (!seen.has(1) || !seen.has(axisCount)) {
      throw new Error(`第 ${i + 1} 次观测必须包含输入轴（轴 1）与输出轴（轴 ${axisCount}）的读数`);
    }
    return { readings };
  });
}

/* ---------------- 结果渲染 ---------------- */

function renderTheory(data) {
  const wrap = el('div');
  wrap.appendChild(el('h3', 'block-title', '理论速比（按齿数精确计算）'));
  const table = el('table', 'pairs');
  table.innerHTML =
    '<thead><tr><th>级（轴间）</th><th>主动轮齿数</th><th>从动轮齿数</th><th>理论速比（主动/从动）</th></tr></thead>';
  const tbody = el('tbody');
  data.stages.forEach((s) => {
    const tr = el('tr');
    tr.innerHTML = `
      <td>第 ${s.stage} 级<div class="torque-rated">轴 ${s.stage} → 轴 ${s.stage + 1}</div></td>
      <td>${s.drive}</td>
      <td>${s.driven}</td>
      <td class="frac">${s.ratio.num}/${s.ratio.den} ≈ ${s.ratio.decimal}</td>`;
    tbody.appendChild(tr);
  });
  const trAll = el('tr');
  trAll.innerHTML = `
    <td><strong>总速比</strong><div class="torque-rated">轴 1 → 轴 ${data.axisCount}</div></td>
    <td colspan="2">—</td>
    <td class="frac"><strong>${data.totalRatio.num}/${data.totalRatio.den}</strong> ≈ ${data.totalRatio.decimal}</td>`;
  tbody.appendChild(trAll);
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderObservation(obs) {
  const wrap = el('div', 'obs-result');
  wrap.appendChild(el('h3', 'block-title', `观测 ${obs.observation}（已测轴：${obs.axes.join('、')}）`));
  const table = el('table', 'pairs');
  table.innerHTML =
    '<thead><tr><th>轴段</th><th>理论速比</th><th>实测速比区间</th><th>判定</th></tr></thead>';
  const tbody = el('tbody');
  obs.segments.forEach((seg) => {
    const tr = el('tr');
    tr.innerHTML = `
      <td>轴 ${seg.from} → 轴 ${seg.to}</td>
      <td class="frac">${seg.theoretical.num}/${seg.theoretical.den} ≈ ${seg.theoretical.decimal}</td>
      <td class="frac">[${seg.lo.decimal}, ${seg.hi.decimal}]</td>
      <td>${seg.ok
        ? '<span class="seg-ok">相符</span>'
        : '<span class="meshing-no">偏离</span>'}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderCandidates(data) {
  const wrap = el('div');
  wrap.appendChild(el('h3', 'block-title', '逐级假设核对（假设该级存在跨观测恒定倍率偏差，其余级正常）'));
  const table = el('table', 'pairs candidate-table');
  table.innerHTML =
    '<thead><tr><th>假设异常级</th><th>结论</th><th>可行倍率区间<br/>（含级轴段跨观测交集）</th><th>交叉核对（不含该级的轴段）</th></tr></thead>';
  const tbody = el('tbody');
  data.candidates.forEach((c) => {
    const tr = el('tr');
    if (c.feasible) tr.className = 'candidate-hit';
    const verdictCell = c.feasible
      ? `<strong class="seg-ok">相容</strong>` +
        (c.containsNormal
          ? '<div class="torque-rated">区间含正常倍率 1，保留不确定性</div>'
          : '<div class="torque-rated">区间不含正常倍率 1</div>')
      : '<span class="meshing-no">不相容</span>';
    const intervalCell = c.interval
      ? `<span class="frac">[${c.interval.lo.decimal}, ${c.interval.hi.decimal}]</span>`
      : '<span class="meshing-no">交集为空</span>';
    const crossCell = c.crossFailures.length
      ? c.crossFailures
          .map((f) => `<div>观测 ${f.observation} 轴 ${f.from}→轴 ${f.to} 偏离理论值</div>`)
          .join('')
      : '<span class="seg-ok">全部通过</span>';
    tr.innerHTML = `
      <td>第 ${c.stage} 级</td>
      <td>${verdictCell}</td>
      <td>${intervalCell}</td>
      <td class="cross-cell">${crossCell}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  wrap.appendChild(el('p', 'muted',
    '可行倍率区间：全部含该级观测轴段（跨观测）换算倍率区间的交集；区间为空或交叉核对存在偏离轴段时，该级假设不成立。'));
  return wrap;
}

/* ---------------- 提交 ---------------- */

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  formError.hidden = true;
  resultPanel.hidden = true;

  let payload;
  try {
    const stages = collectStages();
    payload = { stages, observations: collectObservations(stages.length + 1) };
  } catch (e) {
    formError.textContent = e.message;
    formError.hidden = false;
    return;
  }

  try {
    const resp = await fetch('/api/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '诊断计算失败');

    resultPanel.hidden = true;
    theoryPanel.innerHTML = '';
    obsPanels.innerHTML = '';
    candidatePanel.innerHTML = '';

    resultSummary.textContent =
      `${data.stageCount} 级传动 · ${data.observationCount} 次观测 · 共核对 ${data.totalSegments} 个观测轴段`;

    const meta = VERDICT_META[data.verdict] || VERDICT_META.inconsistent;
    verdictBanner.className = `alert ${meta.cls}`;
    verdictBanner.textContent = `【${meta.label}】${data.message}`;
    verdictBanner.hidden = false;

    theoryPanel.appendChild(renderTheory(data));
    data.observations.forEach((o) => obsPanels.appendChild(renderObservation(o)));
    candidatePanel.appendChild(renderCandidates(data));

    resultPanel.hidden = false;
  } catch (e) {
    theoryPanel.innerHTML = '';
    obsPanels.innerHTML = '';
    candidatePanel.innerHTML = '';
    resultSummary.textContent = '';
    verdictBanner.className = 'alert error';
    verdictBanner.textContent = `请求出错：${e.message}`;
    verdictBanner.hidden = false;
    resultPanel.hidden = false;
  }
});
