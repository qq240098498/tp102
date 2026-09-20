const crypto = require('crypto');
const {
  load,
  save,
  LEVELS,
  STATUSES,
  FILE_TYPES,
  RULE_FIELDS,
  HISTORY_LIMIT,
  MAX_CODE_LENGTH,
  MAX_RULE_NAME_LENGTH,
  MAX_PATTERN_LENGTH,
  MAX_NOTE_LENGTH,
} = require('./store');
const { ApiError, pickText } = require('./errors');
const locks = require('./locks');

// 规则编码固定成大写字母加分段的数字，方便在命中清单里引用
const CODE_PATTERN = /^[A-Z]{2,6}-\d{2,4}$/;

// 保存冲突时逐项列给操作者看的字段名
const FIELD_LABELS = {
  code: '规则编码',
  name: '规则名称',
  level: '级别',
  status: '状态',
  fileType: '适用文件类型',
  pattern: '匹配写法',
  note: '说明',
};

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

// 列表里不带改动历史，历史只在打开单条规则时取
function publicRule(rule) {
  const { history, ...rest } = rule;
  return rest;
}

// 逐字段比对两份规则内容，只留下真正变过的项
function diffFields(before, after) {
  return RULE_FIELDS
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, from: before[field], to: after[field] }));
}

// 改动记录按版本号回到过去：把打开之后每一版的改动从新到旧倒着撤回去
function snapshotAtVersion(rule, version) {
  const snapshot = RULE_FIELDS.reduce((out, field) => {
    out[field] = rule[field];
    return out;
  }, {});
  if (version >= rule.version) return snapshot;
  rule.history
    .filter((entry) => entry.version > version)
    .slice()
    .sort((a, b) => b.version - a.version)
    .forEach((entry) => {
      entry.changes.forEach((change) => { snapshot[change.field] = change.from; });
    });
  return snapshot;
}

// 占用期间落在这一条上的每一次改动，取每个版本最后的记录
function changesSince(rule, baseVersion) {
  const picked = new Map();
  rule.history
    .filter((entry) => entry.version > baseVersion)
    .sort((a, b) => a.version - b.version)
    .forEach((entry) => picked.set(entry.version, entry));
  return Array.from(picked.values()).map((entry) => ({
    version: entry.version,
    at: entry.at,
    operator: entry.operator,
    type: entry.type,
  }));
}

function operatorFrom(payload) {
  const operator = pickText(payload && payload.operator);
  if (!operator) {
    throw new ApiError(400, 'OPERATOR_REQUIRED', '请先在页面右上角填上当前操作者', 'operator');
  }
  return operator;
}

// 保存这一下再确认：确实是占住这条规则的人，且占用没有过期
function ensureHeldBy(ruleId, operator) {
  const current = locks.status(ruleId);
  if (!current || !current.holders.some((item) => item.operator === operator)) {
    throw new ApiError(409, 'RULE_LOCK_LOST', '这一条的占用已经不在你手上，请重新打开后再保存', '');
  }
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
  const lockMap = locks.snapshot();
  return {
    rules: sortRules(list).map((rule) => ({ ...publicRule(rule), lock: lockMap[rule.id] || null })),
    levels: LEVELS.slice(),
    statuses: STATUSES.slice(),
    fileTypes: FILE_TYPES.slice(),
    usedFileTypes,
  };
}

function getRule(id) {
  const data = load();
  const found = data.rules.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  return { ...publicRule(found), history: found.history, lock: locks.status(id) };
}

function createRule(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  operatorFrom(input);
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
    version: 1,
    history: [{
      type: 'create',
      version: 1,
      at: now,
      operator: pickText(input.operator).slice(0, 40),
      changes: [],
      overwrote: [],
      note: '',
    }],
  };
  data.rules.push(created);
  save(data);
  return publicRule(created);
}

// 修改规则：
// 1) 必须由当前占住这条规则的人提交；
// 2) expectedVersion 是打开表单时看到的版本，占用期间被别处改过就拦下；
// 3) force 表示操作者看完逐项对比后选择覆盖，覆盖会在改动记录里写明盖掉了哪几次改动。
function updateRule(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const operator = operatorFrom(input);
  const clientId = pickText(input.clientId);
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new ApiError(400, 'BASE_VERSION_REQUIRED', '缺少打开时的版本号，请重新打开这条规则再保存', '');
  }
  const force = input.force === true;

  const data = load();
  const found = data.rules.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');

  // 先按现有内容做一遍校验，免得操作者处理完冲突才发现有字段不合规矩
  const nextValues = {
    code: input.code === undefined ? found.code : validateCode(input.code, data, found.id),
    name: input.name === undefined ? found.name : validateName(input.name),
    level: input.level === undefined ? found.level : validateLevel(input.level),
    status: input.status === undefined ? found.status : validateStatus(input.status),
    fileType: input.fileType === undefined ? found.fileType : validateFileType(input.fileType),
    pattern: input.pattern === undefined ? found.pattern : validatePattern(input.pattern),
    note: input.note === undefined ? found.note : validateNote(input.note),
  };

  let entryType = 'edit';
  let overwrote = [];
  if (found.version !== expectedVersion) {
    if (expectedVersion > found.version) {
      throw new ApiError(409, 'RULE_VERSION_UNEXPECTED', '这条规则的版本对不上，可能数据被重置过，请重新打开', '');
    }
    // 占用期间被别处改过：哪怕占用恰好过期或已经不在自己手上，也先把逐项对比交出去，
    // 由操作者决定覆盖或放弃；选了覆盖就不再要求锁在自己手上。
    // 版本号涨过但内容其实没变（例如别处做了一次空保存）不算冲突，按普通保存走。
    const opened = snapshotAtVersion(found, expectedVersion);
    const externalChanges = diffFields(opened, found);
    if (externalChanges.length > 0) {
      if (!force) {
        const incoming = RULE_FIELDS.reduce((out, field) => {
          out[field] = input[field] === undefined ? opened[field] : nextValues[field];
          return out;
        }, {});
        const changes = externalChanges.map((change) => ({
          field: change.field,
          label: FIELD_LABELS[change.field],
          opened: change.from,
          now: change.to,
          yours: incoming[change.field],
        }));
        const err = new ApiError(
          409,
          'RULE_CONTENT_CHANGED',
          '这条规则在你打开之后被别人改过，本次保存已拦下，请核对后选择覆盖或放弃',
          '',
        );
        err.detail = {
          expectedVersion,
          currentVersion: found.version,
          changes,
          intervening: changesSince(found, expectedVersion),
          lock: locks.status(id),
        };
        throw err;
      }
      entryType = 'overwrite';
      overwrote = changesSince(found, expectedVersion);
    }
  }
  if (entryType !== 'overwrite') {
    // 内容没有变过才检查占用：防止拿着过期占用把别人正在改的内容盖掉
    ensureHeldBy(id, operator);
  }

  // 一项都没改不造新版本，免得改动记录里混入没有实际内容的保存
  const ownChanges = diffFields(found, nextValues);
  if (ownChanges.length === 0) {
    return publicRule(found);
  }

  Object.assign(found, nextValues);

  const now = new Date().toISOString();
  const newVersion = found.version + 1;
  found.version = newVersion;
  found.updatedAt = now;
  found.history.push({
    type: entryType,
    version: newVersion,
    at: now,
    operator: operator.slice(0, 40),
    changes: ownChanges,
    overwrote,
    note: '',
  });
  if (found.history.length > HISTORY_LIMIT) found.history = found.history.slice(-HISTORY_LIMIT);

  save(data);
  // 覆盖保存时占用可能已不在自己手上（比如占用过期后别人又改了一版），续不上锁不影响已落盘的结果
  try {
    locks.heartbeat(id, operator, clientId);
  } catch (err) {
    if (err.code !== 'RULE_LOCK_LOST') throw err;
  }
  return publicRule(found);
}

function deleteRule(id, payload) {
  // 别人正打开编辑时不能删，免得占用方对着一条已经没了的规则保存；自己占着可以删，占用会一并清掉
  const operator = pickText(payload && payload.operator);
  const current = locks.status(id);
  const heldByOther = current && current.holders.some((item) => item.operator !== operator);
  if (current && (!operator || heldByOther)) {
    const err = new ApiError(409, 'RULE_LOCKED', `这条规则正被 ${current.operator} 占用，等对方保存或取消后再删除`, '');
    err.detail = { lock: current };
    throw err;
  }
  const data = load();
  const index = data.rules.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  const [removed] = data.rules.splice(index, 1);
  save(data);
  locks.clear(id);
  return { id: removed.id, code: removed.code, name: removed.name };
}

// 锁模块抛的是带状态码与错误码的普通异常，进路由前统一包成业务异常
function wrapLockError(err) {
  if (err instanceof ApiError) throw err;
  const wrapped = new ApiError(err.status || 409, err.code || 'RULE_LOCK_ERROR', err.message, err.field || '');
  wrapped.detail = err.detail;
  throw wrapped;
}

// 打开编辑表单时调用：占住这一条，返回占用信息与当前内容
function openRuleForEdit(id, payload) {
  const operator = operatorFrom(payload);
  const clientId = pickText(payload && payload.clientId);
  const data = load();
  const found = data.rules.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  try {
    const lock = locks.acquire(id, operator, clientId);
    return { ...publicRule(found), history: found.history, lock };
  } catch (err) {
    wrapLockError(err);
  }
}

function touchRuleLock(id, payload) {
  const operator = operatorFrom(payload);
  const clientId = pickText(payload && payload.clientId);
  try {
    return locks.heartbeat(id, operator, clientId);
  } catch (err) {
    wrapLockError(err);
  }
}

function closeRuleLock(id, payload) {
  const operator = operatorFrom(payload);
  const clientId = pickText(payload && payload.clientId);
  return locks.release(id, operator, clientId);
}

function getRuleHistory(id) {
  const data = load();
  const found = data.rules.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  return {
    id: found.id,
    code: found.code,
    name: found.name,
    version: found.version,
    history: found.history,
  };
}

function listRuleLocks() {
  return { locks: locks.snapshot() };
}

module.exports = {
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  openRuleForEdit,
  touchRuleLock,
  closeRuleLock,
  getRuleHistory,
  listRuleLocks,
  FIELD_LABELS,
};
