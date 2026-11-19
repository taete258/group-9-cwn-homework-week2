/* app.js · ตัวช่วยฝั่ง browser ที่ทุกหน้าใช้ร่วมกัน (B01)
 *   const r = await EG.api('POST', '/api/drafts', { serviceId: 'SV-01', qty: 2 });  // { ok, status, data }
 *   EG.showError('ข้อความ')    → <div data-testid="action-error" role="alert">
 *   EG.showSuccess('บันทึกแล้ว') → <div data-testid="action-success" role="status">
 *   EG.clearMessages()
 *   ปุ่ม data-action="logout" → POST /api/auth/logout แล้วไป /login
 */
(function () {
  'use strict';

  async function api(method, url, body) {
    const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) { try { data = await res.json(); } catch (e) { data = null; } }
    return { ok: res.ok, status: res.status, data };
  }

  function flashBox() {
    let box = document.getElementById('flash');
    if (!box) { box = document.createElement('div'); box.id = 'flash'; (document.querySelector('main') || document.body).prepend(box); }
    return box;
  }
  function show(testid, cls, role, msg) {
    const box = flashBox();
    let el = box.querySelector('[data-testid="' + testid + '"]');
    if (!el) { el = document.createElement('div'); el.setAttribute('data-testid', testid); box.appendChild(el); }
    el.className = 'alert ' + cls;
    el.setAttribute('role', role);
    el.textContent = msg;
    return el;
  }
  function clearMessages() {
    const box = document.getElementById('flash');
    if (box) box.querySelectorAll('[data-testid="action-error"],[data-testid="action-success"]').forEach((e) => e.remove());
  }
  function showError(msg) {
    const s = document.querySelector('#flash [data-testid="action-success"]'); if (s) s.remove();
    return show('action-error', 'alert-error', 'alert', msg);
  }
  function showSuccess(msg) {
    const e = document.querySelector('#flash [data-testid="action-error"]'); if (e) e.remove();
    return show('action-success', 'alert-success', 'status', msg);
  }

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action="logout"]');
    if (!btn) return;
    ev.preventDefault();
    try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignore */ }
    window.location.href = '/login';
  });

  window.EG = { api, showError, showSuccess, clearMessages };
})();
