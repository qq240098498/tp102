const crypto = require('crypto');
const { load, save, LEVELS, STATUSES, FILE_TYPES, RULE_FIELDS, MAX_CODE_LENGTH, MAX_RULE_NAME_LENGTH, MAX_PATTERN_LENGTH, MAX_NOTE_LENGTH } = require('./store');
const { ApiError, pickText } = require('./errors');

// 规则编码固定成大写字母加分段的数字，方便在命中清单里引用
const CODE_PATTERN = /^[A-Z]{2,6}-\d{2,4}$/;

// 字段的中文叫法，冲突提示与修改记录里都按这个展示
const FIELD_LABELS = {
  code: '规则编码',
  name: '规则名称',
  level: '级别',
  status: '状态',
  fileType: '适用文件类型',
  pattern: '匹配写法',
  note: '说明',
};

// 占用开始那一刻规则的内容，保存时就拿它跟当前内容比对
function snapshotOf(rule) {
  const snapshot = {};
  RULE_FIELDS.forEach((field) => {
    snapshot[field] = typeof rule[field] === 'string' ? rule[field] : '';
  });
  return snapshot;
}

// 两份内容逐项比对，返回 { 字段: { from, to } }，一样的项不出现
function diffRule(before, after) {
  const source = before && typeof before === 'object' ? before : {};
  const target = after && typeof after === 'object' ? after : {};
  const changes = {};
  RULE_FIELDS.forEach((field) => {
    const from = typeof source[field] === 'string' ? source[field] : '';
    const to = typeof target[field] === 'string' ? target[field] : '';
    if (from !== to) changes[field] = { from, to };
  });
  return changes;
}

// 差异转成列表形式，带上字段的中文叫法，给冲突提示用
function diffList(changes) {
  return RULE_FIELDS
    .filter((field) => changes[field])
    .map((field) => ({
      field,
      label: FIELD_LABELS[field],
      was: changes[field].from,
      now: changes[field].to,
    }));
}

// 占用信息对外只给占用人与开始时间，快照留在服务端
function publicLock(lock) {
  return { ruleId: lock.ruleId, operator: lock.operator, since: lock.since };
}

function lockedError(lock) {
  return new ApiError(409, 'RULE_LOCKED', `这条规则正被 ${lock.operator} 占用`, '', {
    lockedBy: lock.operator,
    lockedSince: lock.since,
  });
}

// 留一条痕迹：谁在哪天对哪条规则做了什么；覆盖保存会带上被盖掉的那次改动
function appendHistory(data, rule, kind, operator, changes, overwritten, at) {
  data.ruleHistory.push({
    id: crypto.randomUUID(),
    ruleId: rule.id,
    code: rule.code,
    name: rule.name,
    at,
    operator: operator || '',
    kind,
    changes: changes || {},
    overwritten: overwritten || null,
  });
}

function validateCode(value, data, selfId) {
  const code = pickText(value);
  if (!code) throw new ApiError(400, 'CODE_REQUIRED', '请填写规则编码', 'code');
  if (code.length > MAX_CODE_LENGTH) {
    throw new ApiError(400, 'CODE_TOO_LONG', `规则编码不能超过 ${MAX_CODE_LENGTH} 个字符`, 'code');
  }
  if (!CODE_PATTERN.test(code)) {
    throw new ApiError(400, 'CODE_INVALID', '规则编码要写成大写字母加短横线加数字，例如 CODE-001', 'code');
  }
  const hit = data.rules.find((item) => item.id !== selfId && item.code.toLowerCase() === code.toLowerCase());
  if (hit) throw new ApiError(409, 'CODE_DUPLICATED', `编码 ${hit.code} 已经被 ${hit.name} 用了`, 'code');
  return code;
}

function validateName(value) {
  const name = pickText(value);
  if (!name) throw new ApiError(400, 'NAME_REQUIRED', '请填写规则名称', 'name');
  if (name.length > MAX_RULE_NAME_LENGTH) {
    throw new ApiError(400, 'NAME_TOO_LONG', `规则名称不能超过 ${MAX_RULE_NAME_LENGTH} 个字符`, 'name');
  }
  return name;
}

function validatePattern(value) {
  const pattern = typeof value === 'string' ? value : '';
  if (!pattern.trim()) throw new ApiError(400, 'PATTERN_REQUIRED', '请填写要匹配的写法', 'pattern');
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new ApiError(400, 'PATTERN_TOO_LONG', `匹配写法不能超过 ${MAX_PATTERN_LENGTH} 个字符`, 'pattern');
  }
  return pattern;
}

function validateLevel(value) {
  const level = pickText(value);
  if (!level) return LEVELS[0];
  if (!LEVELS.includes(level)) {
    throw new ApiError(400, 'LEVEL_INVALID', `级别只能是 ${LEVELS.join('、')} 其中之一`, 'level');
  }
  return level;
}

function validateStatus(value) {
  const status = pickText(value);
  if (!status) return STATUSES[0];
  if (!STATUSES.includes(status)) {
    throw new ApiError(400, 'STATUS_INVALID', `状态只能是 ${STATUSES.join('、')} 其中之一`, 'status');
  }
  return status;
}

function validateFileType(value) {
  const fileType = pickText(value);
  if (!fileType) return FILE_TYPES[0];
  if (!FILE_TYPES.includes(fileType)) {
    throw new ApiError(400, 'FILE_TYPE_INVALID', `适用文件类型只能是 ${FILE_TYPES.join('、')} 其中之一`, 'fileType');
  }
  return fileType;
}

function validateNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'NOTE_INVALID', '说明需要是文本', 'note');
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `说明不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

function sortRules(list) {
  return list.slice().sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

// 规则清单：按级别、状态、适用文件类型筛选，再按编码、名称或匹配写法搜索
function listRules(options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const status = pickText(input.status);
  const fileType = pickText(input.fileType);
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();

  let list = data.rules;
  if (level) list = list.filter((item) => item.level === level);
  if (status) list = list.filter((item) => item.status === status);
  if (fileType) list = list.filter((item) => item.fileType === fileType || item.fileType === '全部');
  if (keyword) {
    list = list.filter((item) => item.code.toLowerCase().includes(keyword)
      || item.name.toLowerCase().includes(keyword)
      || item.pattern.toLowerCase().includes(keyword));
  }

  const usedFileTypes = Array.from(new Set(data.rules.map((item) => item.fileType)));
  return {
    rules: sortRules(list),
    levels: LEVELS.slice(),
    statuses: STATUSES.slice(),
    fileTypes: FILE_TYPES.slice(),
    usedFileTypes,
    locks: data.locks.map(publicLock),
  };
}

function getRule(id) {
  const data = load();
  const found = data.rules.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  return found;
}

// 打开编辑表单时占住这条规则：同一个人重复打开不算冲突，换个人打开就告诉他谁占着
function lockRule(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const operator = pickText(input.operator);
  if (!operator) throw new ApiError(400, 'OPERATOR_REQUIRED', '请先在页面右上角填上当前操作者的名字', 'operator');
  const data = load();
  const found = data.rules.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');

  const existing = data.locks.find((item) => item.ruleId === id);
  if (existing && existing.operator !== operator) throw lockedError(existing);
  if (existing) {
    // 同一个人重复打开：开始时间不动，快照刷新成这次打开时的内容
    existing.snapshot = snapshotOf(found);
    save(data);
    return { rule: found, lock: publicLock(existing) };
  }

  const lock = {
    ruleId: id,
    operator,
    since: new Date().toISOString(),
    snapshot: snapshotOf(found),
  };
  data.locks.push(lock);
  save(data);
  return { rule: found, lock: publicLock(lock) };
}

// 关掉编辑表单时释放占用，只有占用者本人能释放
function unlockRule(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const operator = pickText(input.operator);
  const data = load();
  const index = data.locks.findIndex((item) => item.ruleId === id);
  if (index === -1) return { ruleId: id, released: false };
  const lock = data.locks[index];
  if (lock.operator !== operator) throw lockedError(lock);
  data.locks.splice(index, 1);
  save(data);
  return { ruleId: id, released: true };
}

// 某条规则的修改痕迹，新的在前；规则删掉之后痕迹依然查得到
function getRuleHistory(id) {
  const data = load();
  const history = data.ruleHistory
    .filter((item) => item.ruleId === id)
    .slice()
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  return { ruleId: id, fieldLabels: { ...FIELD_LABELS }, history };
}

function createRule(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const operator = pickText(input.operator);
  const data = load();
  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    code: validateCode(input.code, data, ''),
    name: validateName(input.name),
    level: validateLevel(input.level),
    status: validateStatus(input.status),
    fileType: validateFileType(input.fileType),
    pattern: validatePattern(input.pattern),
    note: validateNote(input.note),
    createdAt: now,
    updatedAt: now,
    updatedBy: operator,
  };
  data.rules.push(created);
  appendHistory(data, created, 'create', operator, {}, null, now);
  save(data);
  return created;
}

function updateRule(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const operator = pickText(input.operator);
  const force = input.force === true;
  const data = load();
  const found = data.rules.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');

  const lockIndex = data.locks.findIndex((item) => item.ruleId === id);
  const lock = lockIndex === -1 ? null : data.locks[lockIndex];

  // 占用不拦保存本身：别处的改动照样落库，占着这条规则的人保存时靠快照比对拦下来
  const drift = lock && lock.operator === operator ? diffRule(lock.snapshot, found) : {};
  const hasDrift = Object.keys(drift).length > 0;
  if (lock && !force && hasDrift) {
    throw new ApiError(409, 'RULE_CONFLICT', '占用期间这条规则被别处改动过，本次保存被拦下', '', {
      changedBy: found.updatedBy,
      changedAt: found.updatedAt,
      diff: diffList(drift),
    });
  }

  const previousAt = found.updatedAt;
  const previousBy = found.updatedBy;
  const before = snapshotOf(found);
  found.code = input.code === undefined ? found.code : validateCode(input.code, data, found.id);
  found.name = input.name === undefined ? found.name : validateName(input.name);
  found.level = input.level === undefined ? found.level : validateLevel(input.level);
  found.status = input.status === undefined ? found.status : validateStatus(input.status);
  found.fileType = input.fileType === undefined ? found.fileType : validateFileType(input.fileType);
  found.pattern = input.pattern === undefined ? found.pattern : validatePattern(input.pattern);
  found.note = input.note === undefined ? found.note : validateNote(input.note);
  found.updatedAt = new Date().toISOString();
  if (operator) found.updatedBy = operator;
  const changes = diffRule(before, found);

  if (lock && force && hasDrift) {
    // 覆盖保存：把被盖掉的那次改动（什么时候、谁改的、改了哪几项）一并记下来
    appendHistory(data, found, 'overwrite', operator, changes, {
      at: previousAt,
      operator: previousBy,
      changes: drift,
    }, found.updatedAt);
  } else if (Object.keys(changes).length > 0) {
    appendHistory(data, found, 'update', operator, changes, null, found.updatedAt);
  }
  if (lock && lock.operator === operator) data.locks.splice(lockIndex, 1);
  save(data);
  return found;
}

function deleteRule(id) {
  const data = load();
  const index = data.rules.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  const [removed] = data.rules.splice(index, 1);
  save(data);
  return { id: removed.id, code: removed.code, name: removed.name };
}

module.exports = {
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  lockRule,
  unlockRule,
  getRuleHistory,
};
