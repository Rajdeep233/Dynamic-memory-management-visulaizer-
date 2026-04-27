// ── State ──────────────────────────────────────────────────────────────────
const S = {
  mode: 'paging',
  paging: {
    physSize: 16, pageSize: 4, numProcs: 2, algo: 'LRU',
    frames: [], // [{pid, page, lastUsed, loadTime}|null]
    pageTables: [], // per proc: [{frame, valid}]
    refStrings: [
      [0,1,2,0,3,0,4,2,3,0,3,2,1,2,0,1,7,0,1,2], // proc 0
      [2,3,1,3,2,1,4,2,3,4,0,2,3,1,4,0]            // proc 1
    ],
    refIdx: [0, 0],
    pageFaults: 0, hits: 0,
    timeStep: 0,
    playing: false,
    speed: 800,
    log: [],
    activeProc: 0,
    addrInput: '', addrResult: null,
  },
  seg: {
    memSize: 64,
    processes: [
      { pid: 0, name: 'Process A', segments: [
        { name: 'Code',  size: 8,  base: -1, color: 'seg-code' },
        { name: 'Data',  size: 5,  base: -1, color: 'seg-data' },
        { name: 'Stack', size: 4,  base: -1, color: 'seg-stack' },
        { name: 'Heap',  size: 6,  base: -1, color: 'seg-heap' },
      ]},
      { pid: 1, name: 'Process B', segments: [
        { name: 'Code',  size: 10, base: -1, color: 'seg-code' },
        { name: 'Data',  size: 7,  base: -1, color: 'seg-data' },
        { name: 'Stack', size: 3,  base: -1, color: 'seg-stack' },
      ]},
    ],
    memory: [], // [{pid,segIdx,name}|null], length=memSize
    fragPercent: 0,
    log: [],
    addrInput: { proc: 0, seg: 0, offset: 0 },
    addrResult: null,
  },
  vm: {
    physFrames: 4, numPages: 12, algo: 'LRU',
    frames: [], // [{page,lastUsed,loadTime,dirty}|null]
    pageMeta: [], // [{inMem,frame,dirty}]
    refString: [0,1,2,3,0,1,4,0,1,2,4,3,0,5,4,3,2,1,0,5,2,3,4,1],
    refIdx: 0,
    faults: 0, hits: 0, tlbHits: 0, tlbMisses: 0,
    tlb: [], // [{page, frame}]
    tlbSize: 4,
    playing: false, speed: 900,
    log: [],
    timeStep: 0,
    addrInput: '', addrResult: null,
  }
};

let playTimer = null;

// ── Utilities ──────────────────────────────────────────────────────────────
function log(target, msg, type='info') {
  const arr = target === 'paging' ? S.paging.log : target === 'seg' ? S.seg.log : S.vm.log;
  arr.unshift({ msg, type, time: S[target === 'seg' ? 'seg' : target].timeStep ?? 0 });
  if (arr.length > 30) arr.pop();
}

function addLog(mode, msg, type) {
  const arr = mode === 'seg' ? S.seg.log : S[mode].log;
  arr.unshift({ msg, type });
  if (arr.length > 30) arr.pop();
}

// ── PAGING ENGINE ──────────────────────────────────────────────────────────
function pagingInit() {
  const p = S.paging;
  p.frames = new Array(p.physSize / p.pageSize).fill(null);
  p.pageTables = [];
  const pagesPerProc = 8;
  for (let i = 0; i < p.numProcs; i++) {
    p.pageTables.push(new Array(pagesPerProc).fill(null).map(() => ({ frame: -1, valid: false })));
  }
  p.pageFaults = 0; p.hits = 0; p.timeStep = 0;
  p.refIdx = new Array(p.numProcs).fill(0);
  p.log = [];
  addLog('paging', 'System initialized', 'info');
}

function pagingStep(pid) {
  const p = S.paging;
  const rs = p.refStrings[pid];
  if (!rs || p.refIdx[pid] >= rs.length) return false;
  const page = rs[p.refIdx[pid]++];
  p.timeStep++;
  p.activeProc = pid;

  const frameIdx = p.frames.findIndex(f => f && f.pid === pid && f.page === page);
  if (frameIdx !== -1) {
    p.hits++;
    p.frames[frameIdx].lastUsed = p.timeStep;
    addLog('paging', `P${pid}: Page ${page} → Frame ${frameIdx} (HIT)`, 'ok');
    p.addrResult = { page, frame: frameIdx, offset: 0, physical: frameIdx * p.pageSize };
  } else {
    p.pageFaults++;
    const freeIdx = p.frames.findIndex(f => f === null);
    let targetIdx;
    if (freeIdx !== -1) {
      targetIdx = freeIdx;
    } else {
      targetIdx = pagingVictim(pid, page);
    }
    const old = p.frames[targetIdx];
    if (old) {
      p.pageTables[old.pid][old.page] = { frame: -1, valid: false };
      addLog('paging', `Evicted P${old.pid} Page ${old.page} from Frame ${targetIdx} (${p.algo})`, 'warn');
    }
    p.frames[targetIdx] = { pid, page, lastUsed: p.timeStep, loadTime: p.timeStep, dirty: false };
    if (p.pageTables[pid]) p.pageTables[pid][page] = { frame: targetIdx, valid: true };
    addLog('paging', `P${pid}: Page ${page} → Frame ${targetIdx} (FAULT)`, 'fault');
    p.addrResult = { page, frame: targetIdx, offset: 0, physical: targetIdx * p.pageSize, fault: true };
  }
  return true;
}

function pagingVictim(pid, page) {
  const p = S.paging;
  const algo = p.algo;
  if (algo === 'FIFO') {
    let minTime = Infinity, idx = 0;
    p.frames.forEach((f, i) => { if (f && f.loadTime < minTime) { minTime = f.loadTime; idx = i; } });
    return idx;
  } else if (algo === 'LRU') {
    let minUsed = Infinity, idx = 0;
    p.frames.forEach((f, i) => { if (f && f.lastUsed < minUsed) { minUsed = f.lastUsed; idx = i; } });
    return idx;
  } else { // Optimal
    let maxFuture = -1, idx = 0;
    const rs = p.refStrings[pid];
    const future = rs.slice(p.refIdx[pid]);
    p.frames.forEach((f, i) => {
      if (!f) return;
      const nxt = future.indexOf(f.page);
      const dist = nxt === -1 ? Infinity : nxt;
      if (dist > maxFuture) { maxFuture = dist; idx = i; }
    });
    return idx;
  }
}

// ── SEGMENTATION ENGINE ────────────────────────────────────────────────────
function segInit() {
  const s = S.seg;
  s.memory = new Array(s.memSize).fill(null);
  s.processes.forEach(proc => {
    proc.segments.forEach(seg => { seg.base = -1; });
  });
  s.log = [];
  s.fragPercent = 0;
  addLog('seg', 'Memory cleared', 'info');
}

function segAllocProcess(pid) {
  const s = S.seg;
  const proc = s.processes[pid];
  if (!proc) return;
  proc.segments.forEach((seg, si) => {
    if (seg.base !== -1) return;
    let start = -1, count = 0;
    for (let i = 0; i < s.memSize; i++) {
      if (!s.memory[i]) { if (start === -1) start = i; count++; if (count === seg.size) { break; } }
      else { start = -1; count = 0; }
    }
    if (start !== -1 && count === seg.size) {
      for (let i = start; i < start + seg.size; i++) s.memory[i] = { pid, segIdx: si, name: seg.name };
      seg.base = start;
      addLog('seg', `P${pid} ${seg.name}: base=${start} limit=${seg.size}`, 'ok');
    } else {
      addLog('seg', `P${pid} ${seg.name}: No contiguous block of ${seg.size} (fragmented!)`, 'fault');
    }
  });
  segCalcFrag();
}

function segDeallocProcess(pid) {
  const s = S.seg;
  const proc = s.processes[pid];
  s.memory = s.memory.map(cell => (cell && cell.pid === pid) ? null : cell);
  proc.segments.forEach(seg => { seg.base = -1; });
  addLog('seg', `P${pid} deallocated`, 'warn');
  segCalcFrag();
}

function segCalcFrag() {
  const s = S.seg;
  let free = s.memory.filter(c => !c).length;
  let maxBlock = 0, cur = 0;
  s.memory.forEach(c => { if (!c) { cur++; maxBlock = Math.max(maxBlock, cur); } else cur = 0; });
  const totalFree = free;
  s.fragPercent = totalFree ? Math.round(((totalFree - maxBlock) / totalFree) * 100) : 0;
}

function segTranslate() {
  const s = S.seg;
  const { proc, seg: segIdx, offset } = s.addrInput;
  const proc0 = s.processes[proc];
  if (!proc0 || !proc0.segments[segIdx]) { s.addrResult = { error: 'Invalid segment' }; return; }
  const segment = proc0.segments[segIdx];
  if (segment.base === -1) { s.addrResult = { error: 'Segment not in memory' }; return; }
  if (offset >= segment.size) { s.addrResult = { error: `Offset ${offset} >= limit ${segment.size} (FAULT)` }; return; }
  s.addrResult = { base: segment.base, limit: segment.size, offset, physical: segment.base + offset };
}

// ── VIRTUAL MEMORY ENGINE ──────────────────────────────────────────────────
function vmInit() {
  const v = S.vm;
  v.frames = new Array(v.physFrames).fill(null);
  v.pageMeta = new Array(v.numPages).fill(null).map(() => ({ inMem: false, frame: -1, dirty: false }));
  v.faults = 0; v.hits = 0; v.tlbHits = 0; v.tlbMisses = 0;
  v.tlb = [];
  v.refIdx = 0; v.timeStep = 0;
  v.log = [];
  addLog('vm', 'Virtual memory initialized', 'info');
}

function vmStep() {
  const v = S.vm;
  if (v.refIdx >= v.refString.length) return false;
  const page = v.refString[v.refIdx++];
  v.timeStep++;

  const tlbEntry = v.tlb.find(e => e.page === page);
  if (tlbEntry) {
    v.tlbHits++;
    v.hits++;
    v.frames[tlbEntry.frame].lastUsed = v.timeStep;
    addLog('vm', `Page ${page}: TLB HIT → Frame ${tlbEntry.frame}`, 'ok');
    v.addrResult = { page, frame: tlbEntry.frame, tlbHit: true };
    return true;
  }

  v.tlbMisses++;
  if (v.pageMeta[page].inMem) {
    v.hits++;
    const frame = v.pageMeta[page].frame;
    v.frames[frame].lastUsed = v.timeStep;
    vmUpdateTLB(page, frame);
    addLog('vm', `Page ${page}: TLB MISS, Mem HIT → Frame ${frame}`, 'info');
    v.addrResult = { page, frame, tlbHit: false };
  } else {
    v.faults++;
    const freeIdx = v.frames.findIndex(f => f === null);
    let targetFrame;
    if (freeIdx !== -1) {
      targetFrame = freeIdx;
    } else {
      targetFrame = vmVictim(page);
    }
    const old = v.frames[targetFrame];
    if (old) {
      v.pageMeta[old.page].inMem = false;
      v.pageMeta[old.page].frame = -1;
      v.tlb = v.tlb.filter(e => e.page !== old.page);
      addLog('vm', `Evicted page ${old.page} from frame ${targetFrame}${old.dirty?' (dirty-write)':''}`, 'warn');
    }
    v.frames[targetFrame] = { page, lastUsed: v.timeStep, loadTime: v.timeStep, dirty: Math.random() > 0.7 };
    v.pageMeta[page] = { inMem: true, frame: targetFrame, dirty: false };
    vmUpdateTLB(page, targetFrame);
    addLog('vm', `Page ${page}: PAGE FAULT → loaded into frame ${targetFrame}`, 'fault');
    v.addrResult = { page, frame: targetFrame, tlbHit: false, fault: true };
  }
  return true;
}

function vmVictim(page) {
  const v = S.vm;
  if (v.algo === 'FIFO') {
    let minTime = Infinity, idx = 0;
    v.frames.forEach((f, i) => { if (f && f.loadTime < minTime) { minTime = f.loadTime; idx = i; } });
    return idx;
  } else if (v.algo === 'LRU') {
    let minUsed = Infinity, idx = 0;
    v.frames.forEach((f, i) => { if (f && f.lastUsed < minUsed) { minUsed = f.lastUsed; idx = i; } });
    return idx;
  } else {
    const future = v.refString.slice(v.refIdx);
    let maxDist = -1, idx = 0;
    v.frames.forEach((f, i) => {
      if (!f) return;
      const nxt = future.indexOf(f.page);
      const dist = nxt === -1 ? Infinity : nxt;
      if (dist > maxDist) { maxDist = dist; idx = i; }
    });
    return idx;
  }
}

function vmUpdateTLB(page, frame) {
  const v = S.vm;
  v.tlb = v.tlb.filter(e => e.page !== page);
  v.tlb.unshift({ page, frame });
  if (v.tlb.length > v.tlbSize) v.tlb.pop();
}

// ── RENDERING ──────────────────────────────────────────────────────────────
function render() {
  const main = document.getElementById('mainArea');
  if (!main) return;
  if (S.mode === 'paging') main.innerHTML = renderPaging();
  else if (S.mode === 'segmentation') main.innerHTML = renderSeg();
  else if (S.mode === 'virtual') main.innerHTML = renderVM();
  else main.innerHTML = renderLearn();
  bindEvents();
}

function procColors(pid) {
  return ['used-0','used-1','used-2','used-3','used-4'][pid % 5];
}
function procHex(pid) {
  return [['var(--blue50)','var(--blue200)','var(--blue800)'],['var(--teal50)','var(--teal200)','var(--teal800)'],['var(--amber50)','var(--amber200)','var(--amber800)'],['var(--purple50)','var(--purple200)','#26215C'],['var(--coral50)','var(--coral200)','var(--coral600)']][pid%5];
}

// ── PAGING RENDER ──────────────────────────────────────────────────────────
function renderPaging() {
  const p = S.paging;
  const frameCount = p.physSize / p.pageSize;
  const hitRate = (p.hits + p.pageFaults) > 0 ? Math.round(p.hits / (p.hits + p.pageFaults) * 100) : 0;
  const utilPct = Math.round(p.frames.filter(Boolean).length / frameCount * 100);

  return `
  <div class="sidebar">
    <div class="ctrl-group">
      <div class="ctrl-label">Configuration</div>
      <div class="ctrl-label2">Physical Memory (pages)</div>
      <input type="number" id="physSize" value="${p.physSize}" min="8" max="32" step="4" onchange="S.paging.physSize=+this.value;pagingInit();render()">
      <div class="ctrl-label2">Page Size</div>
      <input type="number" id="pageSize" value="${p.pageSize}" min="1" max="8" step="1" onchange="S.paging.pageSize=+this.value;pagingInit();render()">
      <div class="ctrl-label2">Processes</div>
      <input type="number" id="numProcs" value="${p.numProcs}" min="1" max="4" step="1" onchange="S.paging.numProcs=Math.min(4,+this.value);pagingInit();render()">
    </div>
    <div class="ctrl-group">
      <div class="ctrl-label">Algorithm</div>
      <select onchange="S.paging.algo=this.value">
        <option ${p.algo==='FIFO'?'selected':''}>FIFO</option>
        <option ${p.algo==='LRU'?'selected':''}>LRU</option>
        <option ${p.algo==='Optimal'?'selected':''}>Optimal</option>
      </select>
    </div>
    <div class="ctrl-group">
      <div class="ctrl-label">Simulation</div>
      <div class="btn-row">
        <button class="btn ${p.playing?'warn':'primary'} btn-icon" onclick="pagingTogglePlay()">${p.playing?'⏸':'▶'}</button>
        <button class="btn btn-icon" onclick="pagingStepOne()">⏭</button>
        <button class="btn btn-icon danger" onclick="pagingInit();render()">↺</button>
      </div>
      <div class="speed-row">
        <span>Slow</span>
        <input type="range" min="200" max="2000" step="100" value="${p.speed}" onchange="S.paging.speed=${2000}-this.value+200">
        <span>Fast</span>
      </div>
    </div>
    <div class="ctrl-group">
      <div class="ctrl-label">Active Process</div>
      <div class="proc-legend">${new Array(p.numProcs).fill(0).map((_,i)=>{const c=procHex(i);return`<span class="proc-chip" style="background:${c[0]};color:${c[2]};border:0.5px solid ${c[1]};cursor:pointer" onclick="S.paging.activeProc=${i};render()">P${i}${p.activeProc===i?' ●':''}</span>`}).join('')}</div>
    </div>
    <div class="ctrl-group">
      <div class="ctrl-label">Address Translate</div>
      <div class="ctrl-label2">Page # (P${p.activeProc})</div>
      <input type="number" id="addrPageIn" value="0" min="0" max="7" onchange="translateAddr(+this.value,+document.getElementById('addrOffIn').value)">
      <div class="ctrl-label2">Offset</div>
      <input type="number" id="addrOffIn" value="0" min="0" max="${p.pageSize-1}" onchange="translateAddr(+document.getElementById('addrPageIn').value,+this.value)">
      ${p.addrResult ? renderAddrResult(p.addrResult, p.pageSize) : ''}
    </div>
  </div>

  <div class="canvas-area">
    <div class="card anim-in">
      <div class="card-title">Physical Memory — ${frameCount} Frames (${p.physSize} units total)</div>
      <div class="mem-grid">
        ${p.frames.map((f,i) => {
          const cls = f ? procColors(f.pid) + (p.addrResult && p.addrResult.frame===i ? ' fault':'') : 'free';
          const tt = f ? `Frame ${i}: P${f.pid} Page ${f.page} | LRU:${f.lastUsed}` : `Frame ${i}: Free`;
          return `<div class="mem-frame ${cls}" data-tt="${tt}"><span style="font-size:8px;opacity:.7">${i}</span><span>${f?`P${f.pid}P${f.page}`:''}</span></div>`;
        }).join('')}
      </div>
    </div>

    <div style="display:flex;gap:12px">
      ${new Array(p.numProcs).fill(0).map((_,pid)=>{
        const c = procHex(pid);
        const pt = p.pageTables[pid] || [];
        const remaining = (p.refStrings[pid]||[]).length - (p.refIdx[pid]||0);
        return `<div class="card anim-in" style="flex:1;min-width:0">
          <div class="card-title" style="color:${c[2]}">
            <span style="width:8px;height:8px;border-radius:50%;background:${c[1]};display:inline-block"></span>
            Process ${pid} — Page Table
            <span class="badge ${pid===p.activeProc?'badge-hit':''}" style="margin-left:auto">${remaining} refs left</span>
          </div>
          <table class="ptable">
            <tr><th>Page</th><th>Frame</th><th>Valid</th></tr>
            ${pt.map((e,i)=>`<tr class="${p.addrResult&&p.addrResult.page===i&&pid===p.activeProc?'highlight':''}">
              <td>${i}</td><td>${e&&e.valid?e.frame:'—'}</td>
              <td class="${e&&e.valid?'valid':'invalid'}">${e&&e.valid?'✓':'✗'}</td>
            </tr>`).join('')}
          </table>
        </div>`;
      }).join('')}
    </div>

    <div class="card">
      <div class="card-title">Reference String — P${p.activeProc}</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;padding-top:2px">
        ${(p.refStrings[p.activeProc]||[]).map((pg,i)=>{
          const done = i < (p.refIdx[p.activeProc]||0);
          const cur = i === (p.refIdx[p.activeProc]||0)-1;
          return `<span style="padding:2px 7px;border-radius:4px;font-size:11px;font-weight:${cur?'500':'400'};
            background:${cur?'var(--amber50)':done?'var(--bg2)':'var(--bg)'};
            color:${cur?'var(--amber600)':done?'var(--txt3)':'var(--txt)'};
            border:0.5px solid ${cur?'var(--amber200)':'var(--border)'};">${pg}</span>`;
        }).join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Activity Log</div>
      <div class="log-list">
        ${p.log.map(e=>`<div class="log-entry log-${e.type}">${e.msg}</div>`).join('')}
      </div>
    </div>
  </div>

  <div class="right-panel">
    <div class="card-title">Statistics</div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-val stat-blue">${utilPct}%</div><div class="stat-lbl">Mem Utilization</div></div>
      <div class="stat-card"><div class="stat-val stat-red">${p.pageFaults}</div><div class="stat-lbl">Page Faults</div></div>
      <div class="stat-card"><div class="stat-val stat-green">${p.hits}</div><div class="stat-lbl">Hits</div></div>
      <div class="stat-card"><div class="stat-val stat-amber">${hitRate}%</div><div class="stat-lbl">Hit Rate</div></div>
    </div>
    <div style="height:1px;background:var(--border);margin:4px 0"></div>
    <div class="card-title">Frame Details</div>
    ${p.frames.map((f,i)=>{
      if(!f) return `<div class="tlb-row"><span style="width:22px;text-align:center;color:var(--txt3);font-size:10px">${i}</span><span style="color:var(--txt3);font-size:11px">Free</span></div>`;
      const c=procHex(f.pid);
      return `<div class="tlb-row">
        <span style="width:22px;text-align:center;font-size:10px;color:var(--txt2)">${i}</span>
        <span style="padding:1px 6px;border-radius:4px;background:${c[0]};color:${c[2]};font-size:10px;font-weight:500">P${f.pid}</span>
        <span style="font-size:10px;color:var(--txt2)">Pg${f.page}</span>
        <span style="margin-left:auto;font-size:10px;color:var(--txt3)">t=${f.lastUsed}</span>
      </div>`;
    }).join('')}
    <div style="height:1px;background:var(--border);margin:4px 0"></div>
    <div class="card-title">Scenarios</div>
    <div class="btn-row" style="flex-direction:column">
      <button class="btn" style="font-size:11px" onclick="loadScenario('thrashing')">Thrashing</button>
      <button class="btn" style="font-size:11px" onclick="loadScenario('locality')">Locality</button>
      <button class="btn" style="font-size:11px" onclick="loadScenario('sequential')">Sequential</button>
    </div>
  </div>`;
}

function renderAddrResult(r, pageSize) {
  if (r.error) return `<div style="color:var(--red400);font-size:11px;margin-top:4px">${r.error}</div>`;
  const logical = (r.page * pageSize) + r.offset;
  const physical = r.frame * pageSize + r.offset;
  return `<div class="addr-box">
    <div class="addr-step"><span style="color:var(--txt3);font-size:10px">Logical:</span> <span class="addr-val">${logical}</span></div>
    <div class="addr-step"><span style="color:var(--txt3);font-size:10px">Page/Frame:</span> <span class="addr-val addr-highlight">${r.page} → ${r.frame}</span></div>
    <div class="addr-step"><span style="color:var(--txt3);font-size:10px">Physical:</span> <span class="addr-val">${physical}</span></div>
    ${r.fault?`<div class="badge badge-fault" style="margin-top:4px">Page Fault</div>`:''}
  </div>`;
}

// ── SEGMENTATION RENDER ────────────────────────────────────────────────────
function renderSeg() {
  const s = S.seg;
  const usedCells = s.memory.filter(Boolean).length;
  const utilPct = Math.round(usedCells / s.memSize * 100);

  let barHTML = '';
  let i = 0;
  while (i < s.memory.length) {
    const cell = s.memory[i];
    if (!cell) {
      let run = 0; let j = i;
      while (j < s.memory.length && !s.memory[j]) { run++; j++; }
      const pct = (run / s.memSize * 100).toFixed(1);
      barHTML += `<div class="seg-block seg-free" style="width:${pct}%" data-tt="Free: ${run} units">${run > 3 ? run+'u' : ''}</div>`;
      i = j;
    } else {
      let run = 0; let j = i;
      while (j < s.memory.length && s.memory[j] && s.memory[j].pid === cell.pid && s.memory[j].segIdx === cell.segIdx) { run++; j++; }
      const proc = s.processes[cell.pid];
      const seg = proc ? proc.segments[cell.segIdx] : null;
      const pct = (run / s.memSize * 100).toFixed(1);
      const segCls = seg ? seg.color : 'seg-code';
      barHTML += `<div class="seg-block ${segCls}" style="width:${pct}%" data-tt="P${cell.pid} ${cell.name}: base=${i} size=${run}">${run>4?cell.name.slice(0,3):''}</div>`;
      i = j;
    }
  }

  const segTables = s.processes.map(proc => {
    const c = procHex(proc.pid);
    return `<div class="card anim-in" style="flex:1;min-width:0">
      <div class="card-title" style="color:${c[2]}">
        <span style="width:8px;height:8px;border-radius:50%;background:${c[1]};display:inline-block"></span>
        ${proc.name}
      </div>
      <table class="ptable">
        <tr><th>Seg</th><th>Base</th><th>Limit</th><th>Valid</th></tr>
        ${proc.segments.map((seg,si)=>`<tr>
          <td><span class="badge badge-${seg.color.replace('seg-','')==='code'?'hit':seg.color.replace('seg-','')==='data'?'hit':'miss'}" style="background:var(--bg2);color:var(--txt2)">${seg.name}</span></td>
          <td>${seg.base>=0?seg.base:'—'}</td>
          <td>${seg.size}</td>
          <td class="${seg.base>=0?'valid':'invalid'}">${seg.base>=0?'✓':'✗'}</td>
        </tr>`).join('')}
      </table>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn primary" style="font-size:11px" onclick="segAllocProcess(${proc.pid});render()">Load P${proc.pid}</button>
        <button class="btn danger" style="font-size:11px" onclick="segDeallocProcess(${proc.pid});render()">Free P${proc.pid}</button>
      </div>
    </div>`;
  }).join('');

  return `
  <div class="sidebar">
    <div class="ctrl-group">
      <div class="ctrl-label">Memory Size</div>
      <input type="number" id="segMemSize" value="${s.memSize}" min="32" max="128" step="8" onchange="S.seg.memSize=+this.value;segInit();render()">
    </div>
    <div class="ctrl-group">
      <div class="ctrl-label">Operations</div>
      <button class="btn primary" onclick="segAllocProcess(0);segAllocProcess(1);render()">Load All</button>
      <button class="btn danger" onclick="segInit();render()">Clear All</button>
      <button class="btn warn" onclick="segCompact();render()">Compact Memory</button>
    </div>
    <div class="ctrl-group">
      <div class="ctrl-label">Address Translate</div>
      <div class="ctrl-label2">Process</div>
      <select onchange="S.seg.addrInput.proc=+this.value">
        ${s.processes.map(p=>`<option value="${p.pid}">${p.name}</option>`).join('')}
      </select>
      <div class="ctrl-label2">Segment</div>
      <input type="number" id="segAddrSeg" value="${s.addrInput.seg}" min="0" max="3" onchange="S.seg.addrInput.seg=+this.value">
      <div class="ctrl-label2">Offset</div>
      <input type="number" id="segAddrOff" value="${s.addrInput.offset}" min="0" max="63" onchange="S.seg.addrInput.offset=+this.value">
      <button class="btn primary" onclick="segTranslate();render()">Translate →</button>
      ${s.addrResult ? renderSegAddrResult(s.addrResult) : ''}
    </div>
    <div class="ctrl-group">
      <div class="ctrl-label">Scenarios</div>
      <button class="btn" style="font-size:11px" onclick="loadSegScenario('frag')">Fragmentation Demo</button>
      <button class="btn" style="font-size:11px" onclick="loadSegScenario('compact')">After Compaction</button>
    </div>
  </div>

  <div class="canvas-area">
    <div class="card anim-in">
      <div class="card-title">Physical Memory — ${s.memSize} Units</div>
      <div class="seg-bar">${barHTML}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px">
        ${[['seg-code','Code','blue'],['seg-data','Data','teal'],['seg-stack','Stack','amber'],['seg-heap','Heap','purple'],['seg-free','Free','gray']].map(([cls,lbl,col])=>`<span style="display:flex;align-items:center;gap:4px;font-size:11px"><span style="width:12px;height:12px;border-radius:3px" class="${cls}"></span>${lbl}</span>`).join('')}
        <span style="display:flex;align-items:center;gap:4px;font-size:11px"><span style="width:12px;height:12px;border-radius:3px;background:repeating-linear-gradient(45deg,var(--red50),var(--red50) 2px,var(--red200) 2px,var(--red200) 4px)"></span>Fragmented</span>
      </div>
    </div>

    <div style="display:flex;gap:12px">${segTables}</div>

    <div class="card">
      <div class="card-title">Activity Log</div>
      <div class="log-list">${s.log.map(e=>`<div class="log-entry log-${e.type}">${e.msg}</div>`).join('')}</div>
    </div>
  </div>

  <div class="right-panel">
    <div class="card-title">Memory Statistics</div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-val stat-blue">${utilPct}%</div><div class="stat-lbl">Utilization</div></div>
      <div class="stat-card"><div class="stat-val stat-red">${s.fragPercent}%</div><div class="stat-lbl">Ext. Frag.</div></div>
      <div class="stat-card"><div class="stat-val stat-green">${usedCells}</div><div class="stat-lbl">Used Units</div></div>
      <div class="stat-card"><div class="stat-val stat-amber">${s.memSize - usedCells}</div><div class="stat-lbl">Free Units</div></div>
    </div>
    <div style="height:1px;background:var(--border);margin:4px 0"></div>
    <div class="card-title">Memory Map</div>
    <div style="display:flex;flex-direction:column;gap:2px;font-size:10px">
      ${s.memory.map((c,i)=>{
        if(!c) return `<div style="display:flex;align-items:center;gap:4px;padding:1px 0"><span style="width:28px;color:var(--txt3)">${i}</span><span style="flex:1;height:10px;background:var(--bg2);border-radius:2px"></span></div>`;
        const col = procHex(c.pid);
        return `<div style="display:flex;align-items:center;gap:4px;padding:1px 0"><span style="width:28px;color:var(--txt3)">${i}</span><span style="flex:1;height:10px;background:${col[0]};border-radius:2px;border:0.5px solid ${col[1]}"></span><span style="color:${col[2]};width:40px">P${c.pid}:${c.name.slice(0,3)}</span></div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderSegAddrResult(r) {
  if (r.error) return `<div style="color:var(--red400);font-size:11px;margin-top:6px">${r.error}</div>`;
  return `<div class="addr-box" style="margin-top:6px">
    <div class="addr-step"><span style="color:var(--txt3);font-size:10px">Base:</span><span class="addr-val">${r.base}</span></div>
    <div class="addr-step"><span style="color:var(--txt3);font-size:10px">Offset:</span><span class="addr-val">${r.offset}</span></div>
    <div class="addr-step"><span style="color:var(--txt3);font-size:10px">Physical:</span><span class="addr-val addr-highlight">${r.physical}</span></div>
  </div>`;
}

// ── VIRTUAL MEMORY RENDER ──────────────────────────────────────────────────
function renderVM() {
  const v = S.vm;
  const hitRate = (v.hits + v.faults) > 0 ? Math.round(v.hits / (v.hits + v.faults) * 100) : 0;
  const tlbHitRate = (v.tlbHits + v.tlbMisses) > 0 ? Math.round(v.tlbHits / (v.tlbHits + v.tlbMisses) * 100) : 0;
  const utilPct = Math.round(v.frames.filter(Boolean).length / v.physFrames * 100);

  return `
  <div class="sidebar">
    <div class="ctrl-group">
      <div class="ctrl-label">Configuration</div>
      <div class="ctrl-label2">Physical Frames</div>
      <input type="number" value="${v.physFrames}" min="2" max="8" onchange="S.vm.physFrames=+this.value;vmInit();render()">
      <div class="ctrl-label2">Virtual Pages</div>
      <input type="number" value="${v.numPages}" min="6" max="16" onchange="S.vm.numPages=+this.value;vmInit();render()">
      <div class="ctrl-label2">TLB Size</div>
      <input type="number" value="${v.tlbSize}" min="2" max="8" onchange="S.vm.tlbSize=+this.value;vmInit();render()">
    </div>
    <div class="ctrl-group">
      <div class="ctrl-label">Algorithm</div>
      <select onchange="S.vm.algo=this.value">
        <option ${v.algo==='FIFO'?'selected':''}>FIFO</option>
        <option ${v.algo==='LRU'?'selected':''}>LRU</option>
        <option ${v.algo==='Optimal'?'selected':''}>Optimal</option>
      </select>
    </div>
    <div class="ctrl-group">
      <div class="ctrl-label">Simulation</div>
      <div class="btn-row">
        <button class="btn ${v.playing?'warn':'primary'} btn-icon" onclick="vmTogglePlay()">${v.playing?'⏸':'▶'}</button>
        <button class="btn btn-icon" onclick="vmStepOne()">⏭</button>
        <button class="btn btn-icon danger" onclick="vmInit();render()">↺</button>
      </div>
      <div class="speed-row">
        <span>Slow</span>
        <input type="range" min="200" max="2000" step="100" value="${v.speed}" onchange="S.vm.speed=2200-this.value">
        <span>Fast</span>
      </div>
    </div>
    <div class="ctrl-group">
      <div class="ctrl-label">Address Translate</div>
      <div class="ctrl-label2">Virtual Page</div>
      <input type="number" id="vmAddrPg" value="0" min="0" max="${v.numPages-1}" onchange="vmTranslate(+this.value,+document.getElementById('vmAddrOff').value)">
      <div class="ctrl-label2">Offset</div>
      <input type="number" id="vmAddrOff" value="0" min="0" max="4095" onchange="vmTranslate(+document.getElementById('vmAddrPg').value,+this.value)">
      ${v.addrResult ? renderVMAddrResult(v.addrResult) : ''}
    </div>
    <div class="ctrl-group">
      <div class="ctrl-label">Scenarios</div>
      <button class="btn" style="font-size:11px" onclick="loadVMScenario('thrashing')">Thrashing</button>
      <button class="btn" style="font-size:11px" onclick="loadVMScenario('workingset')">Working Set</button>
      <button class="btn" style="font-size:11px" onclick="loadVMScenario('sequential')">Sequential Scan</button>
    </div>
  </div>

  <div class="canvas-area">
    <div style="display:flex;gap:12px">
      <div class="card anim-in" style="flex:1">
        <div class="card-title">Physical Frames (RAM)</div>
        <div class="mem-grid">
          ${v.frames.map((f,i)=>{
            const isFault = v.addrResult && v.addrResult.frame === i && v.addrResult.fault;
            return `<div class="mem-frame ${f?'used-0':'free'} ${isFault?'fault':''}" data-tt="${f?`Frame ${i}: Page ${f.page} | dirty:${f.dirty?'Y':'N'} | t=${f.lastUsed}`:`Frame ${i}: Free`}">
              <span style="font-size:8px;opacity:.7">${i}</span>
              <span>${f?`P${f.page}`:''}</span>
              ${f&&f.dirty?`<span style="font-size:7px;color:var(--amber400)">D</span>`:''}
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="card anim-in" style="flex:1">
        <div class="card-title">TLB — ${v.tlbSize} entries</div>
        <table class="ptable">
          <tr><th>Page</th><th>Frame</th><th>Status</th></tr>
          ${v.tlb.map(e=>`<tr><td>${e.page}</td><td>${e.frame}</td><td><span class="badge badge-hit">Valid</span></td></tr>`).join('')}
          ${v.tlb.length < v.tlbSize ? `<tr><td colspan="3" style="color:var(--txt3)">— empty slots: ${v.tlbSize - v.tlb.length} —</td></tr>` : ''}
        </table>
      </div>
    </div>

    <div class="card anim-in">
      <div class="card-title">Virtual Address Space — ${v.numPages} pages | Secondary Storage (Disk)</div>
      <div style="display:flex;flex-wrap:wrap;gap:5px;padding-top:4px">
        ${v.pageMeta.map((pm,pg)=>{
          const isCur = v.addrResult && v.addrResult.page === pg;
          return `<div style="text-align:center">
            <div class="disk-page ${pm.inMem?'loaded':''}" style="${isCur?'border-color:var(--amber400);background:var(--amber50)':''}" data-tt="Page ${pg}: ${pm.inMem?'In RAM (Frame '+pm.frame+')':'On Disk'}">
              ${pg}
            </div>
            <div style="font-size:8px;margin-top:2px;color:${pm.inMem?'var(--teal400)':'var(--txt3)'}">${pm.inMem?'RAM':'Disk'}</div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="card anim-in">
      <div class="card-title">Reference String</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${v.refString.map((pg,i)=>{
          const done = i < v.refIdx;
          const cur = i === v.refIdx - 1;
          return `<span style="padding:2px 8px;border-radius:4px;font-size:11px;font-weight:${cur?'500':'400'};
            background:${cur?'var(--amber50)':done?'var(--bg2)':'var(--bg)'};
            color:${cur?'var(--amber600)':done?'var(--txt3)':'var(--txt)'};
            border:0.5px solid ${cur?'var(--amber200)':'var(--border)'};">${pg}</span>`;
        }).join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Activity Log</div>
      <div class="log-list">${v.log.map(e=>`<div class="log-entry log-${e.type}">${e.msg}</div>`).join('')}</div>
    </div>
  </div>

  <div class="right-panel">
    <div class="card-title">Statistics</div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-val stat-blue">${utilPct}%</div><div class="stat-lbl">Mem Usage</div></div>
      <div class="stat-card"><div class="stat-val stat-red">${v.faults}</div><div class="stat-lbl">Page Faults</div></div>
      <div class="stat-card"><div class="stat-val stat-green">${hitRate}%</div><div class="stat-lbl">Hit Rate</div></div>
      <div class="stat-card"><div class="stat-val stat-amber">${tlbHitRate}%</div><div class="stat-lbl">TLB Hit Rate</div></div>
    </div>
    <div style="height:1px;background:var(--border);margin:6px 0"></div>
    <div class="card-title">TLB Performance</div>
    <div style="font-size:11px;color:var(--txt2)">
      <div class="tlb-row"><span>TLB Hits</span><span class="badge badge-hit" style="margin-left:auto">${v.tlbHits}</span></div>
      <div class="tlb-row"><span>TLB Misses</span><span class="badge badge-miss" style="margin-left:auto">${v.tlbMisses}</span></div>
      <div class="tlb-row"><span>Page Faults</span><span class="badge badge-fault" style="margin-left:auto">${v.faults}</span></div>
    </div>
    <div style="height:1px;background:var(--border);margin:6px 0"></div>
    <div class="card-title">Page Status</div>
    <div style="font-size:10px;display:flex;flex-direction:column;gap:2px">
      ${v.pageMeta.map((pm,pg)=>`<div style="display:flex;align-items:center;gap:4px;padding:2px 0">
        <span style="width:24px;color:var(--txt3)">P${pg}</span>
        <span style="flex:1;height:8px;border-radius:2px;background:${pm.inMem?'var(--blue200)':'var(--bg2)'}"></span>
        <span style="width:36px;color:${pm.inMem?'var(--blue600)':'var(--txt3)'}">${pm.inMem?'RAM':'Disk'}</span>
      </div>`).join('')}
    </div>
    ${v.addrResult ? `
    <div style="height:1px;background:var(--border);margin:6px 0"></div>
    <div class="card-title">Last Access</div>
    <div style="font-size:11px">
      <div class="tlb-row"><span>Page</span><span style="margin-left:auto">${v.addrResult.page}</span></div>
      <div class="tlb-row"><span>Frame</span><span style="margin-left:auto">${v.addrResult.frame}</span></div>
      <div class="tlb-row"><span>TLB</span><span class="badge ${v.addrResult.tlbHit?'badge-hit':'badge-miss'}" style="margin-left:auto">${v.addrResult.tlbHit?'HIT':'MISS'}</span></div>
      ${v.addrResult.fault?`<div class="tlb-row"><span>Fault</span><span class="badge badge-fault" style="margin-left:auto">YES</span></div>`:''}
    </div>` : ''}
  </div>`;
}

function renderVMAddrResult(r) {
  if (!r) return '';
  return `<div class="addr-box" style="margin-top:6px">
    <div class="addr-step"><span style="color:var(--txt3);font-size:10px">Virt Page:</span><span class="addr-val">${r.page}</span></div>
    <div class="addr-step"><span style="color:var(--txt3);font-size:10px">→ Frame:</span><span class="addr-val addr-highlight">${r.frame}</span></div>
    <div class="addr-step"><span style="color:var(--txt3);font-size:10px">TLB:</span><span class="badge ${r.tlbHit?'badge-hit':'badge-miss'}">${r.tlbHit?'HIT':'MISS'}</span></div>
    ${r.fault?`<div class="badge badge-fault" style="margin-top:4px">Page Fault</div>`:''}
  </div>`;
}

// ── LEARN RENDER ────────────────────────────────────────────────────────────
function renderLearn() {
  return `
  <div class="canvas-area" style="max-width:780px;margin:0 auto">
    <div class="card learn-section anim-in">
      <div class="learn-title">Paging</div>
      <div class="learn-body">Paging divides virtual memory into fixed-size <b>pages</b> and physical memory into same-size <b>frames</b>. The OS maintains a <b>page table</b> per process that maps virtual page numbers to physical frame numbers.</div>
      <div class="learn-formula">Physical Address = Frame# × PageSize + Offset<br>Logical Address = Page# × PageSize + Offset</div>
      <div class="learn-body"><b>Page Fault:</b> Occurs when a referenced page is not in physical memory. The OS must load it from disk (page replacement algorithm decides which frame to evict).</div>
      <div class="learn-body" style="margin-top:6px"><b>Replacement Algorithms:</b><br>• <b>FIFO</b> — evict the oldest loaded page. Simple but suffers Bélády's anomaly.<br>• <b>LRU</b> — evict least recently used. Near-optimal but expensive to implement.<br>• <b>Optimal (OPT)</b> — evict the page used furthest in the future. Best possible, requires future knowledge.</div>
    </div>
    <div class="card learn-section anim-in">
      <div class="learn-title">Segmentation</div>
      <div class="learn-body">Segmentation divides memory into <b>variable-size segments</b> based on logical program structure (Code, Data, Stack, Heap). Each segment has a <b>base address</b> and a <b>limit</b> (size).</div>
      <div class="learn-formula">Physical Address = Base[segment] + Offset<br>Condition: Offset &lt; Limit[segment] (else → Segmentation Fault)</div>
      <div class="learn-body"><b>External Fragmentation:</b> As segments are allocated and freed, small unusable gaps appear in physical memory. The total free memory may be sufficient, but no single contiguous block is large enough. <b>Compaction</b> solves this by rearranging segments but is expensive.</div>
    </div>
    <div class="card learn-section anim-in">
      <div class="learn-title">Virtual Memory & Demand Paging</div>
      <div class="learn-body">Virtual memory allows processes to use more memory than physically available. Pages are loaded <b>on demand</b> — only when accessed — and swapped to/from disk.</div>
      <div class="learn-formula">Effective Access Time = (1-p) × mem_time + p × (page_fault_service_time)<br>where p = page fault rate</div>
      <div class="learn-body"><b>TLB (Translation Lookaside Buffer):</b> A fast hardware cache of recent page table entries. A TLB hit avoids a full page table walk. Typical TLB hit rates are 99%+, dramatically reducing effective access time.</div>
      <div class="learn-body" style="margin-top:6px"><b>Thrashing:</b> If the working set of pages exceeds available frames, the system spends more time handling page faults than executing processes. CPU utilization plummets while disk I/O saturates.</div>
      <div class="learn-body" style="margin-top:6px"><b>Working Set:</b> The set of pages a process is actively using in a time window Δ. The OS should ensure each process has at least its working set in memory to avoid thrashing.</div>
    </div>
    <div class="card learn-section anim-in">
      <div class="learn-title">Key Formulas Reference</div>
      <div class="learn-formula">Hit Rate = Hits / (Hits + Page Faults) × 100%<br>TLB Hit Rate = TLB Hits / (TLB Hits + TLB Misses) × 100%<br>External Fragmentation % = (Free − Largest_Free_Block) / Free × 100%<br>Memory Utilization = Used_Frames / Total_Frames × 100%</div>
    </div>
    <div class="card learn-section anim-in">
      <div class="learn-title">Comparison: Paging vs Segmentation</div>
      <table class="ptable" style="width:100%">
        <tr><th>Aspect</th><th>Paging</th><th>Segmentation</th></tr>
        <tr><td>Unit size</td><td>Fixed (page size)</td><td>Variable (segment size)</td></tr>
        <tr><td>Fragmentation</td><td>Internal only</td><td>External only</td></tr>
        <tr><td>Address translation</td><td>Page# + Offset</td><td>Segment# + Offset</td></tr>
        <tr><td>Program structure visibility</td><td>None</td><td>Yes (code, stack, heap…)</td></tr>
        <tr><td>Hardware support</td><td>Page table register</td><td>Segment descriptor table</td></tr>
        <tr><td>Modern OS usage</td><td>Dominant (x86-64)</td><td>Historical (x86 legacy)</td></tr>
      </table>
    </div>
  </div>
  <div class="right-panel" style="font-size:12px;color:var(--txt2)">
    <div class="card-title">Quick Navigation</div>
    <div class="btn-row" style="flex-direction:column">
      <button class="btn" onclick="switchMode('paging')">→ Try Paging Mode</button>
      <button class="btn" onclick="switchMode('segmentation')">→ Try Segmentation</button>
      <button class="btn" onclick="switchMode('virtual')">→ Try Virtual Memory</button>
    </div>
    <div style="height:1px;background:var(--border);margin:8px 0"></div>
    <div class="card-title">Keyboard Shortcuts</div>
    <div style="display:flex;flex-direction:column;gap:5px;font-size:11px">
      <div><kbd style="background:var(--bg2);padding:1px 5px;border-radius:3px;border:0.5px solid var(--border2)">Space</kbd> Play/Pause</div>
      <div><kbd style="background:var(--bg2);padding:1px 5px;border-radius:3px;border:0.5px solid var(--border2)">→</kbd> Next Step</div>
      <div><kbd style="background:var(--bg2);padding:1px 5px;border-radius:3px;border:0.5px solid var(--border2)">R</kbd> Reset</div>
      <div><kbd style="background:var(--bg2);padding:1px 5px;border-radius:3px;border:0.5px solid var(--border2)">1-4</kbd> Switch Mode</div>
    </div>
    <div style="height:1px;background:var(--border);margin:8px 0"></div>
    <div class="card-title" style="color:var(--txt3);font-size:11px">Memory Management Visualizer v1.0</div>
    <div style="font-size:11px;color:var(--txt3);line-height:1.6">Interactive simulation of OS memory management concepts. All simulations run client-side with no backend.</div>
  </div>`;
}

// ── ACTIONS ────────────────────────────────────────────────────────────────
function translateAddr(page, offset) {
  const p = S.paging;
  const pt = p.pageTables[p.activeProc];
  if (!pt || !pt[page]) { p.addrResult = { error: 'Page not mapped' }; render(); return; }
  const entry = pt[page];
  if (!entry.valid) { p.addrResult = { error: `Page ${page} not in memory (page fault)` }; render(); return; }
  p.addrResult = { page, frame: entry.frame, offset, physical: entry.frame * p.pageSize + offset };
  render();
}

function vmTranslate(page, offset) {
  const v = S.vm;
  const pm = v.pageMeta[page];
  if (!pm || !pm.inMem) { v.addrResult = { page, frame: -1, fault: true, tlbHit: false, error: `Page ${page} not in memory` }; render(); return; }
  const tlbEntry = v.tlb.find(e => e.page === page);
  v.addrResult = { page, frame: pm.frame, tlbHit: !!tlbEntry, physical: pm.frame * 4096 + offset };
  render();
}

function pagingStepOne() {
  const p = S.paging;
  const pid = p.activeProc;
  const result = pagingStep(pid);
  if (!result) { addLog('paging', `P${pid}: Reference string exhausted`, 'warn'); }
  render();
}

function pagingTogglePlay() {
  S.paging.playing = !S.paging.playing;
  if (S.paging.playing) { clearInterval(playTimer); playTimer = setInterval(() => { if (!pagingStep(S.paging.activeProc)) { S.paging.playing = false; clearInterval(playTimer); } render(); }, S.paging.speed); }
  else clearInterval(playTimer);
  render();
}

function vmStepOne() {
  const result = vmStep();
  if (!result) { addLog('vm', 'Reference string exhausted', 'warn'); }
  render();
}

function vmTogglePlay() {
  S.vm.playing = !S.vm.playing;
  if (S.vm.playing) { clearInterval(playTimer); playTimer = setInterval(() => { if (!vmStep()) { S.vm.playing = false; clearInterval(playTimer); } render(); }, S.vm.speed); }
  else clearInterval(playTimer);
  render();
}

function segCompact() {
  const s = S.seg;
  s.memory = new Array(s.memSize).fill(null);
  let ptr = 0;
  s.processes.forEach(proc => {
    proc.segments.forEach((seg, si) => {
      if (seg.base !== -1) {
        for (let i = ptr; i < ptr + seg.size; i++) s.memory[i] = { pid: proc.pid, segIdx: si, name: seg.name };
        seg.base = ptr;
        ptr += seg.size;
      }
    });
  });
  s.fragPercent = 0;
  addLog('seg', 'Memory compacted — all fragments coalesced', 'ok');
}

function loadScenario(name) {
  pagingInit();
  if (name === 'thrashing') {
    S.paging.physSize = 8; S.paging.pageSize = 4;
    S.paging.refStrings[0] = [0,1,2,3,4,0,1,2,3,4,0,1,2,3,4,0,1];
    addLog('paging', 'Loaded thrashing scenario — working set exceeds frames', 'warn');
  } else if (name === 'locality') {
    S.paging.refStrings[0] = [0,1,2,0,1,2,0,1,2,3,4,3,4,3,4,5,5];
    addLog('paging', 'Loaded locality scenario — good temporal locality', 'info');
  } else if (name === 'sequential') {
    S.paging.refStrings[0] = [0,1,2,3,4,5,6,7,0,1,2,3,4,5,6,7];
    addLog('paging', 'Loaded sequential scan — worst case for LRU/FIFO', 'warn');
  }
  render();
}

function loadSegScenario(name) {
  segInit();
  if (name === 'frag') {
    segAllocProcess(0); segAllocProcess(1);
    segDeallocProcess(0);
    addLog('seg', 'Fragmentation demo: P0 freed, gaps remain', 'warn');
  } else if (name === 'compact') {
    segAllocProcess(0); segAllocProcess(1);
    segDeallocProcess(0);
    segCompact();
  }
  render();
}

function loadVMScenario(name) {
  vmInit();
  if (name === 'thrashing') {
    S.vm.physFrames = 3; S.vm.numPages = 8;
    S.vm.refString = [0,1,2,3,4,5,0,1,2,3,4,5,0,1,2,3,4,5,0,1,2];
    addLog('vm', 'Thrashing: 6-page working set in 3 frames', 'fault');
  } else if (name === 'workingset') {
    S.vm.physFrames = 4;
    S.vm.refString = [0,1,2,0,1,2,0,1,2,3,4,5,3,4,5,3,4,5,0,1,2];
    addLog('vm', 'Working set shifts from {0,1,2} to {3,4,5}', 'info');
  } else if (name === 'sequential') {
    S.vm.physFrames = 4; S.vm.numPages = 8;
    S.vm.refString = [0,1,2,3,4,5,6,7,0,1,2,3,4,5,6,7,0,1,2];
    addLog('vm', 'Sequential scan — no reuse, max faults', 'warn');
  }
  render();
}

// ── MODE SWITCH ────────────────────────────────────────────────────────────
function switchMode(mode) {
  clearInterval(playTimer);
  S.paging.playing = false;
  S.vm.playing = false;
  S.mode = mode;
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    const modes = ['paging','segmentation','virtual','learn'];
    b.classList.toggle('active', modes[i] === mode);
  });
  render();
}

// ── TOOLTIP ────────────────────────────────────────────────────────────────
function bindEvents() {
  document.querySelectorAll('[data-tt]').forEach(el => {
    el.addEventListener('mouseenter', e => {
      const tt = document.getElementById('tooltip');
      tt.textContent = el.dataset.tt;
      tt.classList.add('show');
    });
    el.addEventListener('mousemove', e => {
      const tt = document.getElementById('tooltip');
      tt.style.left = (e.clientX + 12) + 'px';
      tt.style.top = (e.clientY - 28) + 'px';
    });
    el.addEventListener('mouseleave', () => {
      document.getElementById('tooltip').classList.remove('show');
    });
  });
}

// ── KEYBOARD ───────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === ' ') { e.preventDefault(); if (S.mode==='paging') pagingTogglePlay(); else if (S.mode==='virtual') vmTogglePlay(); }
  if (e.key === 'ArrowRight') { if (S.mode==='paging') pagingStepOne(); else if (S.mode==='virtual') vmStepOne(); }
  if (e.key === 'r' || e.key === 'R') { if (S.mode==='paging') { pagingInit(); render(); } else if (S.mode==='virtual') { vmInit(); render(); } else if (S.mode==='segmentation') { segInit(); render(); } }
  if (e.key === '1') switchMode('paging');
  if (e.key === '2') switchMode('segmentation');
  if (e.key === '3') switchMode('virtual');
  if (e.key === '4') switchMode('learn');
});

// ── INIT ───────────────────────────────────────────────────────────────────
pagingInit();
segInit();
vmInit();
render();
