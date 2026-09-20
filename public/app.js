// 页面交互：规则、文件与扫描三块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上
// 规则编辑走“打开即占用”：取锁、定时心跳、取消或离开时释放；保存时带打开时的版本号，
// 占用期间被别人改过会当场拦下并逐项对比，由操作者选择覆盖或放弃

const state = {
  rules: [],
  files: [],
  levels: [],
  statuses: [],
  fileTypes: [],
  ruleLevels: [],
  ruleStatuses: [],
  ruleFileTypes: [],
  editingRuleId: '',
  // 另存为新规则时用：表单外观是新建，但字段是从某条已存在的规则带出来的
  saveAsFromCode: '',
  editingRuleBaseVersion: 0,
  ruleLockLost: false,
  heartbeatTimer: 0,
  waitTimer: 0,
  editingFileId: '',
  lastScan: null,
};

// 每个标签页一个编号，同一个操作者在两个标签页打开同一条规则时可以分别持有、分别释放
const CLIENT_ID = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HEARTBEAT_INTERVAL_MS = 25000;
const WAIT_POLL_INTERVAL_MS = 3000;

const FIELD_LABELS = {
  code: '规则编码',
  name: '规则名称',
  level: '级别',
  status: '状态',
  fileType: '适用文件类型',
  pattern: '匹配写法',
  note: '说明',
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明、出错位置与明细一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    failure.detail = error.detail || null;
    failure.status = res.status;
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把出错位置标到具体输入项上：规则区与文件区共用一套标记
function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA'
    ? target
    : target.querySelector('input, select, textarea');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatClock(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function levelClass(level) {
  if (level === '错误') return 'lv-error';
  if (level === '警告') return 'lv-warn';
  return 'lv-hint';
}

const OPERATOR_KEY = 'check-hits-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

// 占用提示条：绿色表示锁在自己手上，黄色表示占用出了状况
function setLockBanner(kind, html) {
  const banner = el('rule-lock-banner');
  if (!html) {
    banner.className = 'lock-banner hidden';
    banner.innerHTML = '';
    return;
  }
  banner.className = `lock-banner${kind === 'mine' ? ' mine' : ''}`;
  banner.innerHTML = html;
}

function lockHeldByMe(lock) {
  const operator = currentOperator();
  return !!lock && !!operator && lock.holders.some((item) => item.operator === operator);
}

// ── 弹层：占用冲突、保存冲突、改动记录都走这一个 ──────────────────────────────
function openModal(options) {
  el('modal-title').textContent = options.title || '';
  el('modal-body').innerHTML = options.bodyHtml || '';
  const actions = el('modal-actions');
  actions.innerHTML = '';
  (options.actions || []).forEach((action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.text;
    if (action.kind === 'ghost') button.className = 'ghost';
    if (action.kind === 'danger') button.className = 'danger-solid';
    button.addEventListener('click', () => {
      if (action.keepOpen) action.onClick && action.onClick(button);
      else {
        closeModal();
        action.onClick && action.onClick(button);
      }
    });
    actions.appendChild(button);
  });
  el('modal-mask').classList.remove('hidden');
}

function closeModal() {
  el('modal-mask').classList.add('hidden');
  el('modal-title').textContent = '';
  el('modal-body').innerHTML = '';
  el('modal-actions').innerHTML = '';
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

async function loadRules(options) {
  const silent = !!(options && options.silent);
  const params = new URLSearchParams();
  const level = el('rule-filter-level').value;
  const status = el('rule-filter-status').value;
  const fileType = el('rule-filter-type').value;
  const keyword = el('rule-filter-keyword').value.trim();
  if (level) params.set('level', level);
  if (status) params.set('status', status);
  if (fileType) params.set('fileType', fileType);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/rules${query ? `?${query}` : ''}`);
  state.rules = payload.rules || [];
  state.levels = payload.levels || [];
  state.statuses = payload.statuses || [];
  state.fileTypes = payload.fileTypes || [];
  // 定时静默刷新只更新清单表体（占用徽章在这里），不重建各下拉，免得打断正在展开的选项
  if (!silent) {
    renderRuleFilters();
    renderScanRuleOptions();
  }
  renderRules();
}

async function loadFiles() {
  const params = new URLSearchParams();
  const type = el('file-filter-type').value;
  const keyword = el('file-filter-keyword').value.trim();
  if (type) params.set('type', type);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/files${query ? `?${query}` : ''}`);
  state.files = payload.files || [];
  state.ruleFileTypes = payload.fileTypes || [];
  renderFileFilters();
  renderFiles();
  renderScanFileOptions();
}

function renderRuleFilters() {
  const levelSelect = el('rule-filter-level');
  const levelCurrent = levelSelect.value;
  levelSelect.innerHTML = '<option value="">全部级别</option>'
    + state.levels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.levels.includes(levelCurrent)) levelSelect.value = levelCurrent;

  const statusSelect = el('rule-filter-status');
  const statusCurrent = statusSelect.value;
  statusSelect.innerHTML = '<option value="">全部状态</option>'
    + state.statuses.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.statuses.includes(statusCurrent)) statusSelect.value = statusCurrent;

  const typeSelect = el('rule-filter-type');
  const typeCurrent = typeSelect.value;
  typeSelect.innerHTML = '<option value="">全部适用文件类型</option>'
    + state.fileTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.fileTypes.includes(typeCurrent)) typeSelect.value = typeCurrent;

  const formLevel = el('rule-level');
  const formLevelCurrent = formLevel.value;
  formLevel.innerHTML = state.levels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.levels.includes(formLevelCurrent)) formLevel.value = formLevelCurrent;

  const formStatus = el('rule-status');
  const formStatusCurrent = formStatus.value;
  formStatus.innerHTML = state.statuses.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.statuses.includes(formStatusCurrent)) formStatus.value = formStatusCurrent;

  const formType = el('rule-file-type');
  const formTypeCurrent = formType.value;
  formType.innerHTML = state.fileTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.fileTypes.includes(formTypeCurrent)) formType.value = formTypeCurrent;

  const scanLevel = el('scan-level');
  const scanLevelCurrent = scanLevel.value;
  scanLevel.innerHTML = '<option value="">全部级别</option>'
    + state.levels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.levels.includes(scanLevelCurrent)) scanLevel.value = scanLevelCurrent;
}

function renderFileFilters() {
  const typeSelect = el('file-filter-type');
  const current = typeSelect.value;
  typeSelect.innerHTML = '<option value="">全部类型</option>'
    + state.ruleFileTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.ruleFileTypes.includes(current)) typeSelect.value = current;
}

function renderScanRuleOptions() {
  const select = el('scan-rule');
  const current = select.value;
  select.innerHTML = '<option value="">全部规则</option>'
    + state.rules.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.code)} ${escapeHtml(item.name)}</option>`).join('');
  if (state.rules.some((item) => item.id === current)) select.value = current;
}

function renderScanFileOptions() {
  const select = el('scan-file');
  const current = select.value;
  select.innerHTML = '<option value="">全部文件</option>'
    + state.files.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.path)}</option>`).join('');
  if (state.files.some((item) => item.id === current)) select.value = current;
}

// 占用列：占用人与起始时间直接写在清单上，鼠标悬停能看到完整时间
function renderLockCell(lock) {
  if (!lock) return '<td class="lock-cell">—</td>';
  const mine = lockHeldByMe(lock);
  const label = mine ? '我占用中' : `${lock.operator} 占用中`;
  const title = `占用人：${lock.holders.map((item) => item.operator).join('、')}　起始：${formatTime(lock.acquiredAt)}`;
  return `<td class="lock-cell"><span class="lock-badge${mine ? ' mine' : ''}" title="${escapeHtml(title)}">
    <span class="lock-dot"></span>${escapeHtml(label)} ${escapeHtml(formatClock(lock.acquiredAt))}</span></td>`;
}

function renderRules() {
  const body = el('rule-body');
  body.innerHTML = state.rules.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td><span class="tag ${levelClass(item.level)}">${escapeHtml(item.level)}</span></td>
      <td>${escapeHtml(item.status)}</td>
      <td>${escapeHtml(item.fileType)}</td>
      <td class="mono">${escapeHtml(item.pattern)}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      ${renderLockCell(item.lock)}
      <td class="actions">
        <button type="button" class="link" data-rule-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link" data-rule-history="${escapeHtml(item.id)}">改动记录</button>
        <button type="button" class="link danger" data-rule-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('rule-empty').classList.toggle('hidden', state.rules.length > 0);
}

function renderFiles() {
  const body = el('file-body');
  body.innerHTML = state.files.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.path)}</td>
      <td>${escapeHtml(item.type)}</td>
      <td>${item.lineCount} 行</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-file-view="${escapeHtml(item.id)}">看内容</button>
        <button type="button" class="link" data-file-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-file-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('file-empty').classList.toggle('hidden', state.files.length > 0);
}

// ── 规则编辑表单 ────────────────────────────────────────────────────────────
function fillRuleForm(rule) {
  el('rule-code').value = rule ? rule.code : '';
  el('rule-name').value = rule ? rule.name : '';
  el('rule-level').value = rule ? rule.level : (state.levels[0] || '提示');
  el('rule-status').value = rule ? rule.status : (state.statuses[0] || '启用');
  el('rule-file-type').value = rule ? rule.fileType : (state.fileTypes[0] || '全部');
  el('rule-pattern').value = rule ? rule.pattern : '';
  el('rule-note').value = rule ? rule.note : '';
}

function stopHeartbeat() {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = 0;
  }
}

function stopWaiting() {
  if (state.waitTimer) {
    clearInterval(state.waitTimer);
    state.waitTimer = 0;
  }
}

function startHeartbeat(ruleId) {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(async () => {
    try {
      await request(`/api/rules/${encodeURIComponent(ruleId)}/edit-lock/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ operator: currentOperator(), clientId: CLIENT_ID }),
      });
    } catch (err) {
      stopHeartbeat();
      if (err.code === 'RULE_LOCK_LOST') {
        state.ruleLockLost = true;
        setLockBanner('warn', '占用已经失效（可能长时间没有操作被自动收回），请关掉表单重新打开后再保存。');
        notify('这一条的占用已失效，请重新打开', 'error');
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

// 取锁成功后进入编辑：记下打开时的版本，保存时拿它跟服务端比对
function enterEditMode(rule) {
  state.editingRuleId = rule.id;
  state.editingRuleBaseVersion = rule.version || 1;
  state.ruleLockLost = false;
  state.saveAsFromCode = '';
  el('rule-form-title').textContent = `编辑规则：${rule.code}`;
  fillRuleForm(rule);
  const lock = rule.lock;
  setLockBanner('mine', `你从 <span class="lock-time">${escapeHtml(formatTime(lock ? lock.acquiredAt : ''))}</span> 起占用这条规则（第 ${rule.version} 版）；在你保存或取消前，别人打开会被拦下。`);
  el('rule-form').classList.remove('hidden');
  el('rule-code').focus();
  startHeartbeat(rule.id);
}

function enterCreateMode(prefill, fromCode) {
  stopHeartbeat();
  stopWaiting();
  state.editingRuleId = '';
  state.editingRuleBaseVersion = 0;
  state.ruleLockLost = false;
  state.saveAsFromCode = fromCode || '';
  el('rule-form-title').textContent = fromCode ? `另存为新规则（原规则 ${fromCode}）` : '新建规则';
  fillRuleForm(prefill || null);
  if (fromCode) {
    setLockBanner('warn', `原规则 ${escapeHtml(fromCode)} 正被别人占用，这里按“另存为新规则”处理：改个编码后保存，会生成一条独立的新规则，不动对方占用的那一条。`);
  } else {
    setLockBanner('', '');
  }
  el('rule-form').classList.remove('hidden');
  el('rule-code').focus();
}

// 放开占用并收起表单；放开失败（锁已过期等）不影响收表单
async function releaseAndCloseRuleForm() {
  stopHeartbeat();
  stopWaiting();
  const ruleId = state.editingRuleId;
  const operator = currentOperator();
  state.editingRuleId = '';
  state.editingRuleBaseVersion = 0;
  state.saveAsFromCode = '';
  el('rule-form').classList.add('hidden');
  setLockBanner('', '');
  clearFieldMarks();
  if (ruleId && operator) {
    try {
      await request(`/api/rules/${encodeURIComponent(ruleId)}/edit-lock`, {
        method: 'DELETE',
        body: JSON.stringify({ operator, clientId: CLIENT_ID }),
      });
    } catch (err) {
      // 锁超时或服务重启后本来就没有占用，无需打扰操作者
    }
  }
  loadRules().catch(() => {});
}

function closeRuleForm() {
  state.editingRuleId = '';
  state.editingRuleBaseVersion = 0;
  state.saveAsFromCode = '';
  stopHeartbeat();
  el('rule-form').classList.add('hidden');
  setLockBanner('', '');
  clearFieldMarks();
}

function openFileForm(file) {
  state.editingFileId = file ? file.id : '';
  el('file-form-title').textContent = file ? `编辑文件：${file.path}` : '收录新文件';
  el('file-path').value = file ? file.path : '';
  el('file-content').value = file ? file.content : '';
  el('file-note').value = file ? file.note : '';
  el('file-form').classList.remove('hidden');
  el('file-path').focus();
}

function closeFileForm() {
  state.editingFileId = '';
  el('file-form').classList.add('hidden');
  clearFieldMarks();
}

async function showFileContent(id) {
  clearNotice();
  try {
    const file = await request(`/api/files/${encodeURIComponent(id)}`);
    const preview = el('file-preview');
    preview.textContent = `${file.path}（${file.lineCount} 行）\n${'─'.repeat(40)}\n${file.content}`;
    preview.classList.remove('hidden');
  } catch (err) {
    notify(err.message, 'error');
  }
}

// 点编辑：先取锁。同一个人重复打开直接进表单；换个人打开弹出占用提示，由操作者选择等待或另存
async function startEditRule(ruleId) {
  clearNotice();
  const operator = currentOperator();
  if (!operator) {
    notify('请先在页面右上角填上当前操作者，再打开规则编辑', 'error');
    el('operator').focus();
    return;
  }

  // 已经在编辑这一条：不重新取锁、不用服务端内容盖掉表单里还没保存的修改，把表单露出来即可
  if (state.editingRuleId === ruleId) {
    el('rule-form').classList.remove('hidden');
    el('rule-form').scrollIntoView({ block: 'nearest' });
    return;
  }

  // 已经在编辑别的规则：先把上一条的占用放开
  if (state.editingRuleId) {
    await releaseAndCloseRuleForm();
  }

  let rule;
  try {
    rule = await request(`/api/rules/${encodeURIComponent(ruleId)}/edit-lock`, {
      method: 'POST',
      body: JSON.stringify({ operator, clientId: CLIENT_ID }),
    });
  } catch (err) {
    if (err.code === 'RULE_LOCKED' && err.detail && err.detail.lock) {
      showLockConflictModal(ruleId, err.detail.lock);
      return;
    }
    notify(err.message, 'error');
    return;
  }
  enterEditMode(rule);
  loadRules().catch(() => {});
}

// 异人占用：可以等着（对方一释放就自动接上），也可以把当前内容另存为一条新规则
function showLockConflictModal(ruleId, lock) {
  const others = (lock.holders || []).filter((item) => item.operator !== currentOperator());
  const holders = others.length > 0 ? others : (lock.holders || []);
  const lines = holders.map((item) => `<li><strong>${escapeHtml(item.operator)}</strong>　从 ${escapeHtml(formatTime(item.acquiredAt))} 开始占用</li>`).join('');
  const body = `
    <p class="modal-text">这条规则正被别人占用，同一时间只能由一个人编辑，免得后存的把先存的盖掉。</p>
    <ul>${lines}</ul>
    <p class="modal-text muted" id="wait-line">你可以等对方保存或取消后自动接上，也可以把它另存为一条新规则。</p>`;

  const doAcquire = async () => {
    try {
      const rule = await request(`/api/rules/${encodeURIComponent(ruleId)}/edit-lock`, {
        method: 'POST',
        body: JSON.stringify({ operator: currentOperator(), clientId: CLIENT_ID }),
      });
      stopWaiting();
      closeModal();
      enterEditMode(rule);
      loadRules().catch(() => {});
      notify('对方已释放，已由你接上编辑', 'ok');
    } catch (err) {
      if (err.code !== 'RULE_LOCKED') {
        stopWaiting();
        closeModal();
        notify(err.message, 'error');
      }
    }
  };

  const startWaiting = (button) => {
    if (state.waitTimer) return;
    const waitLine = el('wait-line');
    if (waitLine) waitLine.innerHTML = '<span class="waiting-line"><span class="spinner"></span>正在等待对方释放，会每隔几秒看一眼，释放后自动接上…</span>';
    button.disabled = true;
    state.waitTimer = setInterval(doAcquire, WAIT_POLL_INTERVAL_MS);
  };

  const saveAs = async () => {
    stopWaiting();
    try {
      const latest = await request(`/api/rules/${encodeURIComponent(ruleId)}`);
      enterCreateMode(latest, latest.code);
      notify('已按另存处理：改个编码后保存，会生成一条新规则', 'ok');
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  openModal({
    title: '这条规则正被占用',
    bodyHtml: body,
    actions: [
      { text: '等待对方释放', kind: 'ghost', keepOpen: true, onClick: startWaiting },
      { text: '另存为新规则', onClick: saveAs },
      { text: '取消', kind: 'ghost', onClick: stopWaiting },
    ],
  });
}

function readRulePayload() {
  return {
    code: el('rule-code').value,
    name: el('rule-name').value,
    level: el('rule-level').value,
    status: el('rule-status').value,
    fileType: el('rule-file-type').value,
    pattern: el('rule-pattern').value,
    note: el('rule-note').value,
  };
}

async function submitRule(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const operator = currentOperator();
  if (!operator) {
    notify('请先在页面右上角填上当前操作者', 'error');
    el('operator').focus();
    return;
  }
  const payload = { ...readRulePayload(), operator };
  const editing = state.editingRuleId;

  // 新建与另存为新规则：都是新增一条，不涉及占用
  if (!editing) {
    try {
      await request('/api/rules', { method: 'POST', body: JSON.stringify(payload) });
      notify(state.saveAsFromCode ? `已另存为新规则，原规则 ${state.saveAsFromCode} 没有动` : '规则已新增', 'ok');
      closeRuleForm();
      await loadRules();
    } catch (err) {
      notify(err.message, 'error');
      markField(err.field);
    }
    return;
  }

  // 心跳报过失锁也照常提交：服务端会区分“占用期间内容被改过”（仍给逐项对比）
  // 与“只是占用过期、内容没动”（返回占用失效），由服务端结论决定下一步，不在前端提前替用户拒绝

  try {
    await request(`/api/rules/${encodeURIComponent(editing)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...payload, clientId: CLIENT_ID, expectedVersion: state.editingRuleBaseVersion }),
    });
    notify('规则已保存', 'ok');
    await releaseAndCloseRuleForm();
  } catch (err) {
    if (err.code === 'RULE_CONTENT_CHANGED' && err.detail) {
      showContentConflictModal(editing, payload, err.detail);
      return;
    }
    if (err.code === 'RULE_LOCK_LOST') {
      stopHeartbeat();
      state.ruleLockLost = true;
      setLockBanner('warn', '占用已经失效（可能长时间没有操作被自动收回），请关掉表单重新打开后再保存。');
      notify(err.message, 'error');
      return;
    }
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 保存冲突：逐项列出哪几项被改了、打开时是什么、现在是什么；覆盖或放弃由操作者定
function showContentConflictModal(ruleId, payload, detail) {
  const rows = (detail.changes || []).map((item) => `
    <tr>
      <td>${escapeHtml(item.label || FIELD_LABELS[item.field] || item.field)}</td>
      <td class="opened">${escapeHtml(item.opened) || '<span class="modal-text muted">（空）</span>'}</td>
      <td class="now">${escapeHtml(item.now) || '<span class="modal-text muted">（空）</span>'}</td>
      <td>${escapeHtml(item.yours) || '<span class="modal-text muted">（空）</span>'}</td>
    </tr>`).join('');

  const intervening = (detail.intervening || []).map((item) => {
    const typeText = item.type === 'overwrite' ? '覆盖保存' : '改动保存';
    return `<li>第 ${item.version} 版　${escapeHtml(item.operator)}　${escapeHtml(formatTime(item.at))}　${typeText}</li>`;
  }).join('');

  const body = `
    <p class="modal-text">这条规则在你打开之后被别处改动过，本次保存已当场拦下。下面逐项列出打开时的内容、现在的内容，以及你这次想改成的内容。</p>
    ${intervening ? `<p class="modal-text muted">占用期间的改动：</p><ul>${intervening}</ul>` : ''}
    <table class="conflict-table">
      <thead><tr><th>项目</th><th>打开时</th><th>现在（别处改后）</th><th>你这次填的</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="modal-text muted" style="margin-top:8px">选择“覆盖”会用你这次填的内容盖过上面的改动，并在改动记录里写明盖掉的是哪一次改动；选择“放弃”则丢掉本次改动，规则保持现在的内容。</p>`;

  const overwrite = async () => {
    try {
      await request(`/api/rules/${encodeURIComponent(ruleId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...payload,
          clientId: CLIENT_ID,
          expectedVersion: detail.expectedVersion,
          force: true,
        }),
      });
      const overwritten = (detail.intervening || []).map((item) => `第 ${item.version} 版（${item.operator} ${formatTime(item.at)}）`).join('、');
      notify(`已覆盖保存，被盖掉的是：${overwritten || '占用期间的改动'}；可在改动记录里查看`, 'ok');
      await releaseAndCloseRuleForm();
      await loadRules();
    } catch (err) {
      notify(err.message, 'error');
      markField(err.field);
    }
  };

  const abandon = async () => {
    notify('已放弃本次改动，规则保持别人改后的内容', 'ok');
    await releaseAndCloseRuleForm();
    await loadRules();
  };

  openModal({
    title: '保存被拦下：这条规则已被别人改过',
    bodyHtml: body,
    actions: [
      { text: '覆盖：用我的内容保存', kind: 'danger', onClick: overwrite },
      { text: '放弃本次改动', onClick: abandon },
      { text: '返回表单继续改', kind: 'ghost' },
    ],
  });
}

// 改动记录：新建、改动、覆盖都在这里；覆盖记录写明盖掉了哪一次改动
async function showRuleHistory(ruleId) {
  clearNotice();
  let detail;
  try {
    detail = await request(`/api/rules/${encodeURIComponent(ruleId)}/history`);
  } catch (err) {
    notify(err.message, 'error');
    return;
  }

  const typeText = { create: '建档', edit: '改动', overwrite: '覆盖' };
  const rows = detail.history.slice().reverse().map((entry) => {
    const changes = (entry.changes || []).map((change) => {
      const label = FIELD_LABELS[change.field] || change.field;
      return `<li>${escapeHtml(label)}：${escapeHtml(change.from) || '（空）'} → ${escapeHtml(change.to) || '（空）'}</li>`;
    }).join('');
    const overwrote = (entry.overwrote || []).map((item) =>
      `<li>第 ${item.version} 版　${escapeHtml(item.operator)}　${escapeHtml(formatTime(item.at))} 的改动</li>`).join('');
    return `
      <tr>
        <td>第 ${entry.version} 版</td>
        <td><span class="history-type ${escapeHtml(entry.type)}">${typeText[entry.type] || entry.type}</span></td>
        <td>${escapeHtml(entry.operator)}</td>
        <td class="mono">${escapeHtml(formatTime(entry.at))}</td>
        <td>
          ${changes ? `<ul class="history-changes">${changes}</ul>` : '<span class="modal-text muted">建档基线</span>'}
          ${overwrote ? `<div class="history-overwrite">这次覆盖掉：<ul class="history-changes">${overwrote}</ul></div>` : ''}
        </td>
      </tr>`;
  }).join('');

  const body = `
    <p class="modal-text muted">${escapeHtml(detail.code)} ${escapeHtml(detail.name)}，当前第 ${detail.version} 版，最新在最上面。</p>
    <table class="history-table">
      <thead><tr><th>版本</th><th>类型</th><th>操作者</th><th>时间</th><th>内容</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  openModal({ title: `改动记录：${detail.code}`, bodyHtml: body, actions: [{ text: '关闭', kind: 'ghost' }] });
}

async function submitFile(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    path: el('file-path').value,
    content: el('file-content').value,
    note: el('file-note').value,
  };
  const editing = state.editingFileId;
  try {
    if (editing) {
      await request(`/api/files/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('文件已保存', 'ok');
    } else {
      await request('/api/files', { method: 'POST', body: JSON.stringify(payload) });
      notify('文件已收录', 'ok');
    }
    closeFileForm();
    await loadFiles();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 扫一遍，把概要与命中清单都画出来
async function runScan() {
  clearNotice();
  const body = {
    ruleId: el('scan-rule').value,
    fileId: el('scan-file').value,
    level: el('scan-level').value,
  };
  try {
    const result = await request('/api/scan', { method: 'POST', body: JSON.stringify(body) });
    state.lastScan = result;
    renderScan(result);
  } catch (err) {
    notify(err.message, 'error');
  }
}

function renderScan(result) {
  el('scan-meta').textContent = `扫描时刻 ${formatTime(result.scannedAt)}　参与比对的规则 ${result.rulesUsed} 条（启用共 ${result.enabledRules} 条）　范围里的文件 ${result.filesInScope} 个（清单共 ${result.filesTotal} 个）`;

  const warningBox = el('scan-warning');
  if (result.warning) {
    warningBox.textContent = result.warning;
    warningBox.classList.remove('hidden');
  } else {
    warningBox.classList.add('hidden');
    warningBox.textContent = '';
  }

  const summaryBox = el('scan-summary');
  const levelText = Object.keys(result.summary.byLevel)
    .map((key) => `${key} ${result.summary.byLevel[key]} 条`)
    .join('　');
  const ruleText = result.summary.byRule
    .map((item) => `${item.code} ${item.count} 条`)
    .join('　') || '没有规则命中';
  const fileText = result.summary.byFile
    .map((item) => `${item.path} ${item.count} 条`)
    .join('　') || '没有文件命中';
  summaryBox.innerHTML = `
    <div class="summary-line"><strong>一共命中 ${result.summary.total} 条</strong>　${escapeHtml(levelText)}</div>
    <div class="summary-line">按规则：${escapeHtml(ruleText)}</div>
    <div class="summary-line">按文件：${escapeHtml(fileText)}</div>`;
  summaryBox.classList.remove('hidden');

  const body = el('hit-body');
  body.innerHTML = result.hits.map((hit) => `<tr>
      <td class="mono">${escapeHtml(hit.code)}</td>
      <td><span class="tag ${levelClass(hit.level)}">${escapeHtml(hit.level)}</span></td>
      <td>${escapeHtml(hit.ruleName)}</td>
      <td class="mono">${escapeHtml(hit.path)}</td>
      <td class="mono">${hit.lineNo}</td>
      <td class="mono line-cell">${escapeHtml(hit.lineText)}</td>
    </tr>`).join('');
  el('hit-empty').classList.toggle('hidden', result.hits.length > 0);
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.ruleEdit) {
    await startEditRule(node.dataset.ruleEdit);
    return;
  }

  if (node.dataset.ruleHistory) {
    await showRuleHistory(node.dataset.ruleHistory);
    return;
  }

  if (node.dataset.ruleDelete) {
    clearNotice();
    const found = state.rules.find((item) => item.id === node.dataset.ruleDelete);
    if (!window.confirm(`确定删除规则 ${found ? found.code : ''} 吗？`)) return;
    try {
      await request(`/api/rules/${encodeURIComponent(node.dataset.ruleDelete)}`, {
        method: 'DELETE',
        body: JSON.stringify({ operator: currentOperator(), clientId: CLIENT_ID }),
      });
      if (state.editingRuleId === node.dataset.ruleDelete) await releaseAndCloseRuleForm();
      notify('规则已删除', 'ok');
      await loadRules();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.fileView) {
    await showFileContent(node.dataset.fileView);
    return;
  }

  if (node.dataset.fileEdit) {
    clearNotice();
    try {
      const file = await request(`/api/files/${encodeURIComponent(node.dataset.fileEdit)}`);
      openFileForm(file);
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.fileDelete) {
    clearNotice();
    const found = state.files.find((item) => item.id === node.dataset.fileDelete);
    if (!window.confirm(`确定把 ${found ? found.path : ''} 移出清单吗？`)) return;
    try {
      await request(`/api/files/${encodeURIComponent(node.dataset.fileDelete)}`, { method: 'DELETE' });
      if (state.editingFileId === node.dataset.fileDelete) closeFileForm();
      el('file-preview').classList.add('hidden');
      notify('文件已移出清单', 'ok');
      await loadFiles();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('rule-form').addEventListener('submit', submitRule);
el('file-form').addEventListener('submit', submitFile);
el('rule-new').addEventListener('click', () => {
  clearNotice();
  if (state.editingRuleId) {
    releaseAndCloseRuleForm().then(() => enterCreateMode(null, ''));
  } else {
    enterCreateMode(null, '');
  }
});
el('rule-cancel').addEventListener('click', () => {
  if (state.editingRuleId) releaseAndCloseRuleForm();
  else closeRuleForm();
});
el('modal-close').addEventListener('click', () => {
  stopWaiting();
  closeModal();
});
el('modal-mask').addEventListener('click', (event) => {
  if (event.target === el('modal-mask')) {
    stopWaiting();
    closeModal();
  }
});
el('file-new').addEventListener('click', () => {
  clearNotice();
  openFileForm(null);
});
el('file-cancel').addEventListener('click', closeFileForm);
el('rule-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-filter-reset').addEventListener('click', () => {
  el('rule-filter-level').value = '';
  el('rule-filter-status').value = '';
  el('rule-filter-type').value = '';
  el('rule-filter-keyword').value = '';
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-refresh').addEventListener('click', () => {
  clearNotice();
  loadRules()
    .then(loadFiles)
    .catch((err) => notify(err.message, 'error'));
});
el('file-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadFiles().catch((err) => notify(err.message, 'error'));
});
el('file-filter-reset').addEventListener('click', () => {
  el('file-filter-type').value = '';
  el('file-filter-keyword').value = '';
  loadFiles().catch((err) => notify(err.message, 'error'));
});
el('scan-run').addEventListener('click', runScan);
el('rule-filter-level').addEventListener('change', () => {
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-filter-status').addEventListener('change', () => {
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 关掉标签页时尽量把占用放开；页面内轮询只刷新占用信息，不动筛选条件
window.addEventListener('pagehide', () => {
  const ruleId = state.editingRuleId;
  const operator = currentOperator();
  stopHeartbeat();
  if (ruleId && operator && navigator.sendBeacon) {
    const blob = new Blob([JSON.stringify({ operator, clientId: CLIENT_ID })], { type: 'application/json' });
    navigator.sendBeacon(`/api/rules/${encodeURIComponent(ruleId)}/edit-lock/release`, blob);
  }
});
// 定时静默刷新规则清单，占用徽章才能及时反映别人打开、释放的变化；
// 只重绘清单与下拉（下拉会保留当前选中值），不碰正在填写的表单输入项
setInterval(() => {
  loadRules({ silent: true }).catch(() => {});
}, 15000);

// 页面打开时先把规则与文件都拉一遍，扫描的范围下拉依赖这两份清单
restoreOperator();
loadHealth();
loadRules()
  .then(loadFiles)
  .catch((err) => notify(err.message, 'error'));
