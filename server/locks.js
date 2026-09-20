// 规则编辑占用锁：打开编辑表单时占住这一条，页面据此显示当前由谁占用、从什么时候开始。
// 锁只存在本进程内存里（工具单机使用、不落盘）；持有者每隔一段时间发一次心跳，
// 超过 TTL 没有心跳就认为人已经离开，锁自动释放，避免一条规则被永久占住。

const LOCK_TTL_MS = Number(process.env.LOCK_TTL_MS) > 0 ? Number(process.env.LOCK_TTL_MS) : 90 * 1000;

const locks = new Map();

function operatorName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 同一操作者可能在多个标签页里打开同一条规则，持有记录按“操作者 + 标签页编号”区分
function findRecord(ruleId, operator, clientId) {
  const lock = locks.get(ruleId);
  if (!lock || !operator) return null;
  if (clientId) {
    return lock.holders.find((item) => item.operator === operator && item.clientId === clientId) || null;
  }
  return lock.holders.find((item) => item.operator === operator) || null;
}

function purgeIfDead(ruleId) {
  const lock = locks.get(ruleId);
  if (!lock) return;
  const now = Date.now();
  lock.holders = lock.holders.filter((item) => now - item.lastBeat <= LOCK_TTL_MS);
  if (lock.holders.length === 0) locks.delete(ruleId);
}

// 占用一条规则。
// 同一个人重复打开同一条规则不算冲突：补一条持有记录并返回当前占用情况；
// 换个人打开会抛 RULE_LOCKED，错误明细里写清占用人与起始占用时间，由页面决定等待还是另存。
function acquire(ruleId, operator, clientId) {
  const name = operatorName(operator);
  if (!name) {
    const err = new Error('占用规则前要先填上当前操作者');
    err.status = 400;
    err.code = 'OPERATOR_REQUIRED';
    err.field = 'operator';
    throw err;
  }

  purgeIfDead(ruleId);
  const now = Date.now();
  let lock = locks.get(ruleId);

  if (lock) {
    const others = lock.holders.filter((item) => item.operator !== name);
    if (others.length > 0) {
      const earliest = others.reduce((min, item) => (item.acquiredAt < min.acquiredAt ? item : min), others[0]);
      const err = new Error(`这条规则正被 ${earliest.operator} 占用`);
      err.status = 409;
      err.code = 'RULE_LOCKED';
      err.field = '';
      err.detail = { lock: publicLock(ruleId, lock) };
      throw err;
    }

    // 自己已经在这个标签页开着：续上即可；同一个操作者在另一个标签页打开：再加一条持有
    const existing = findRecord(ruleId, name, clientId || null);
    if (existing) {
      existing.lastBeat = now;
    } else {
      lock.holders.push({ operator: name, clientId: clientId || `tab-${now}`, acquiredAt: now, lastBeat: now });
    }
    return publicLock(ruleId, locks.get(ruleId));
  }

  lock = { holders: [{ operator: name, clientId: clientId || `tab-${now}`, acquiredAt: now, lastBeat: now }] };
  locks.set(ruleId, lock);
  return publicLock(ruleId, lock);
}

// 心跳：占用期间定时报活，并查一眼是不是已经有别人也占用了（正常不会，只在锁过期重占的空档出现）
function heartbeat(ruleId, operator, clientId) {
  const name = operatorName(operator);
  purgeIfDead(ruleId);
  const lock = locks.get(ruleId);
  const holder = lock && name ? findRecord(ruleId, name, clientId || null) : null;
  if (!holder) {
    const err = new Error('占用已经失效，请重新打开这条规则');
    err.status = 409;
    err.code = 'RULE_LOCK_LOST';
    err.field = '';
    err.detail = { lock: lock ? publicLock(ruleId, lock) : null };
    throw err;
  }
  holder.lastBeat = Date.now();
  return publicLock(ruleId, locks.get(ruleId));
}

// 只放开当前标签页的持有；这个操作者还在别的标签页开着时，占用仍然保留
function release(ruleId, operator, clientId) {
  const name = operatorName(operator);
  const lock = locks.get(ruleId);
  if (!lock || !name) return { ruleId, released: false, lock: null };
  const before = lock.holders.length;
  lock.holders = lock.holders.filter(
    (item) => !(item.operator === name && (!clientId || item.clientId === clientId)),
  );
  const removed = before - lock.holders.length;
  if (lock.holders.length === 0) locks.delete(ruleId);
  return { ruleId, released: removed > 0, lock: locks.has(ruleId) ? publicLock(ruleId, locks.get(ruleId)) : null };
}

function status(ruleId) {
  purgeIfDead(ruleId);
  const lock = locks.get(ruleId);
  return lock ? publicLock(ruleId, lock) : null;
}

function snapshot() {
  Array.from(locks.keys()).forEach(purgeIfDead);
  const out = {};
  for (const [ruleId, lock] of locks) out[ruleId] = publicLock(ruleId, lock);
  return out;
}

// 规则被删除时一并清掉它的占用
function clear(ruleId) {
  locks.delete(ruleId);
}

function publicLock(ruleId, lock) {
  const holders = lock.holders.map((item) => ({
    operator: item.operator,
    clientId: item.clientId,
    acquiredAt: new Date(item.acquiredAt).toISOString(),
    lastBeatAt: new Date(item.lastBeat).toISOString(),
  }));
  const earliest = holders.reduce((min, item) => (item.acquiredAt < min.acquiredAt ? item : min), holders[0]);
  return {
    ruleId,
    operator: earliest.operator,
    acquiredAt: earliest.acquiredAt,
    ttlSeconds: Math.round(LOCK_TTL_MS / 1000),
    holders,
  };
}

module.exports = {
  LOCK_TTL_MS,
  acquire,
  heartbeat,
  release,
  status,
  snapshot,
  clear,
};
