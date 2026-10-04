export const GENERIC_CONTROLS = 'button,[role="button"],input[type="submit"],input[type="image"],[data-action="send"],[data-action="submit"],[tabindex="0"]:not(a)';
const SEND_LABEL = /^(?:send(?: (?:message|prompt|question))?|submit|发送(?:消息|提示|问题)?|提交|提问|送信|envoyer|enviar|senden)$/i;
const OTHER_ACTION = /(?:attach|upload|file|feedback|share|copy|download|voice|microphone|附件|上传|文件|反馈|分享|复制|下载|语音|麦克风)/i;
const SEND_TOKEN = /(?:^|[-_\s])(?:send|submit)(?:$|[-_\s])/i;
const iconCache = new WeakMap();
const tokens = value => value.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
const cleanLabel = value => value.trim().replace(/\s*[（(\[].*?[）)\]]\s*$/, '').trim();

export function isDisabledControl(element) {
  return Boolean(element.disabled || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('data-disabled') === 'true' || element.getAttribute('data-state') === 'disabled'
    || /(?:^|[-_\s])disabled(?:$|[-_\s])/i.test(tokens(element.getAttribute('class') || '')));
}

function upwardArrow(svg) {
  const shapes = [...svg.querySelectorAll('path,line,polyline,polygon,rect,circle,ellipse')];
  if (!shapes.length || shapes.length > 4 || shapes.some(shape => ['rect', 'circle', 'ellipse'].includes(shape.localName))) return false;
  const signature = [...svg.attributes].map(a => `${a.name}=${a.value}`).join('|') + shapes.map(shape => [...shape.attributes].map(a => `${a.name}=${a.value}`).join('|')).join(';');
  const cached = iconCache.get(svg);
  if (cached?.signature === signature) return cached.value;
  let value = false;
  try {
    const points = [];
    for (const shape of shapes) {
      if (typeof shape.getTotalLength !== 'function' || typeof shape.getPointAtLength !== 'function') return false;
      const length = shape.getTotalLength();
      if (!Number.isFinite(length) || length <= 0) return false;
      const matrix = shape.getCTM?.();
      for (let step = 0; step <= 64; step++) {
        const p = shape.getPointAtLength(length * step / 64);
        points.push(matrix ? { x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f } : p);
      }
    }
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const left = Math.min(...xs), top = Math.min(...ys), width = Math.max(...xs) - left, height = Math.max(...ys) - top;
    if (width <= 0 || height <= 0) return false;
    const normalized = points.map(p => ({ x: (p.x - left) / width, y: (p.y - top) / height }));
    const span = rows => rows.length ? Math.max(...rows.map(p => p.x)) - Math.min(...rows.map(p => p.x)) : 0;
    const tip = normalized.filter(p => p.y < .08);
    const tail = normalized.filter(p => p.y > .88);
    const shoulders = normalized.filter(p => p.y > .2 && p.y < .4);
    value = tip.length > 0 && tail.length > 0 && tip.every(p => p.x > .3 && p.x < .7)
      && span(tail) < .35 && tail.every(p => p.x > .28 && p.x < .72) && span(shoulders) > .25;
  } catch { value = false; }
  iconCache.set(svg, { signature, value });
  return value;
}

function nearbyIcon(element, editor) {
  const a = element.getBoundingClientRect(), b = editor.getBoundingClientRect();
  if (a.width && a.height && (a.width > a.height * 3 || a.height > a.width * 3)) return false;
  if (a.width && b.width && (a.right < b.left - 80 || a.left > b.right + 80 || a.bottom < b.top - 80 || a.top > b.bottom + 140)) return false;
  const icons = [...element.querySelectorAll('svg')];
  if (icons.length !== 1) return false;
  const icon = icons[0];
  const name = tokens(['class', 'data-icon', 'data-lucide', 'aria-label'].map(key => icon.getAttribute(key) || '').join(' '));
  return SEND_TOKEN.test(name) || /(?:^|[-_\s])(?:arrow-up|paper-plane)(?:$|[-_\s])/.test(name) || upwardArrow(icon);
}

/** Confidence comes from HTML semantics and icon shape, never a site hostname. */
export function genericSendScore(element, editor) {
  if (element.tagName === 'INPUT' && !['submit', 'image'].includes(element.type)) return 0;
  const labels = ['aria-label', 'title'].map(key => element.getAttribute(key) || '');
  const text = element.tagName === 'INPUT' ? element.value : element.textContent;
  if (labels.some(label => OTHER_ACTION.test(label)) || OTHER_ACTION.test(text.trim())) return 0;
  if ([...labels, text].some(label => SEND_LABEL.test(cleanLabel(label)))) return 3;
  const marker = tokens(['data-testid', 'data-test-id', 'data-action', 'id', 'class', 'name'].map(key => element.getAttribute(key) || '').join(' '));
  if (SEND_TOKEN.test(marker)) return 2;
  const form = editor.closest('form');
  if (form && element.form === form && ['submit', 'image'].includes(element.type)) return element.hasAttribute('type') ? 3 : 2;
  return nearbyIcon(element, editor) ? 1 : 0;
}

export function genericConnectionIssue(document, visible) {
  const transport = /websocket|real[- ]time connection|实时连接/i;
  const failure = /block(?:ed|ing)?|fail(?:ed|ure)?|trouble|unavailable|cannot|can't|中断|失败|无法|阻止|阻拦|异常/i;
  const messages = [...document.querySelectorAll('[role="alert"],[role="status"][aria-live]')].filter(el => visible(el)
    && !el.closest('[contenteditable],textarea,input,[data-sider-enhancement],[role="log"],[data-message-id],[data-testid="conversation-turn"]')
    && transport.test(el.textContent) && failure.test(el.textContent));
  return messages.length === 1 ? messages[0].textContent.trim().slice(0, 1000) : '';
}
