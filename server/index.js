const path = require('path');
const express = require('express');
const api = require('./api');

const app = express();
const PORT = process.env.PORT || 5102;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 健康检查：页面右上角据此显示服务连接状态
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, port: PORT });
});

app.get('/api/rules', (req, res) => {
  res.json(api.listRules({
    level: api.readQuery(req.query, 'level'),
    status: api.readQuery(req.query, 'status'),
    fileType: api.readQuery(req.query, 'fileType'),
    keyword: api.readQuery(req.query, 'keyword'),
  }));
});

app.post('/api/rules', (req, res) => {
  try {
    res.status(201).json(api.createRule(req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/rules/:id', (req, res) => {
  try {
    res.json(api.getRule(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

// 打开编辑表单时占住这一条；心跳续期；取消或离开时放开
app.post('/api/rules/:id/edit-lock', (req, res) => {
  try {
    res.json(api.openRuleForEdit(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/rules/:id/edit-lock/heartbeat', (req, res) => {
  try {
    res.json(api.touchRuleLock(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/rules/:id/edit-lock', (req, res) => {
  try {
    res.json(api.closeRuleLock(req.params.id, req.body || {}));
  } catch (err) {
    sendError(res, err);
  }
});

// 页面关掉标签页时只能用 sendBeacon 报个 POST，单独留一个释放入口
app.post('/api/rules/:id/edit-lock/release', (req, res) => {
  try {
    res.json(api.closeRuleLock(req.params.id, req.body || {}));
  } catch (err) {
    sendError(res, err);
  }
});

// 一条规则的改动记录：覆盖留痕也在这里看得到
app.get('/api/rules/:id/history', (req, res) => {
  try {
    res.json(api.getRuleHistory(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

// 当前所有占用情况，供页面标注哪些规则正被人占着
app.get('/api/rule-locks', (_req, res) => {
  res.json(api.listRuleLocks());
});

app.patch('/api/rules/:id', (req, res) => {
  try {
    res.json(api.updateRule(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/rules/:id', (req, res) => {
  try {
    res.json(api.deleteRule(req.params.id, req.body || {}));
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/files', (req, res) => {
  res.json(api.listFiles({
    type: api.readQuery(req.query, 'type'),
    keyword: api.readQuery(req.query, 'keyword'),
  }));
});

app.post('/api/files', (req, res) => {
  try {
    res.status(201).json(api.createFile(req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/files/:id', (req, res) => {
  try {
    res.json(api.getFile(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

app.patch('/api/files/:id', (req, res) => {
  try {
    res.json(api.updateFile(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/files/:id', (req, res) => {
  try {
    res.json(api.deleteFile(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

// 扫一遍：可以只扫某一条规则、某一个文件，也可以只留某个级别
app.post('/api/scan', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    res.json(api.scan({
      level: body.level,
      fileId: body.fileId,
      ruleId: body.ruleId,
    }));
  } catch (err) {
    sendError(res, err);
  }
});

// 未匹配到的接口路径统一返回说明，避免前端拿到一串页面内容
app.use('/api', (_req, res) => {
  res.status(404).json({ error: { code: 'API_NOT_FOUND', message: '接口不存在', field: '' } });
});

// 统一错误出口：业务异常按状态码与错误码返回，其余按服务异常处理
function sendError(res, err) {
  if (err instanceof api.ApiError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        field: err.field,
        detail: err.detail === undefined ? null : err.detail,
      },
    });
  }
  console.error('[tp102] 处理请求时出现未预期的问题：', err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: '服务内部异常，请稍后重试', field: '' },
  });
}

// 请求体解析失败时给出明确说明
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'BODY_INVALID_JSON', message: '提交的内容不是合法的 JSON', field: '' },
    });
  }
  if (err) return sendError(res, err);
  return next();
});

app.listen(PORT, () => {
  console.log(`检查规则与命中清单工作台已启动：http://localhost:${PORT}`);
});
