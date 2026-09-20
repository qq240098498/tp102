// 带错误码与出错位置的业务异常，页面据此把问题标到具体输入项上；
// details 放结构化的附加信息（比如占用人、字段差异），页面据此渲染提示
class ApiError extends Error {
  constructor(status, code, message, field, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field || '';
    this.details = details === undefined ? null : details;
  }
}

// 去掉首尾空白后的文本，非字符串一律当作空
function pickText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = { ApiError, pickText };
