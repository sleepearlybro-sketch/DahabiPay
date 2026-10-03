import { composeWhatsapp } from './phone.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const state = { offer: null, quoteToken: '', quote: null, step: 1, resendUntil: 0 };
async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || 'Unable to complete this request'), body);
  return body;
}
function money(v, dp = 2) { return Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
function showStep(number) {
  state.step = number;
  $$('[data-step]').forEach((el) => el.classList.toggle('hidden', Number(el.dataset.step) !== number));
  $$('.steps i').forEach((el, i) => el.classList.toggle('on', i < number));
  $('.exchange').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function error(message = '', field) {
  const box = $('[data-step="' + state.step + '"] .error');
  if (box) box.textContent = message;
  if (field) $('#' + field)?.focus();
}
function loading(button, active, label) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = active;
  button.innerHTML = active ? '<span class="spinner"></span>' + label : button.dataset.label;
}
function contact() {
  return { fullName: $('#fullName').value, email: $('#email').value, whatsapp: normalizedWhatsapp(), moneygoAccount: $('#moneygoAccount').value, note: $('#note').value, quoteToken: state.quoteToken };
}
function normalizedWhatsapp() {
  return composeWhatsapp($('#whatsapp').value, $('#whatsappCountry').value, $('#customDialCode').value);
}
function updateWhatsappPreview() {
  const raw = $('#whatsapp').value.trim();
  const selected = $('#whatsappCountry').value;
  const preview = normalizedWhatsapp();
  $('#whatsappPreview').textContent = preview || (selected === 'other' ? 'Add country code' : $('#whatsappCountry').selectedOptions[0].textContent.split(' ').at(-1));
  $('#whatsappPreview').classList.toggle('phone-preview--invalid', Boolean(raw && !/^\+[1-9]\d{7,14}$/.test(preview)));
  $('#whatsappHelpText').textContent = /^\+|^00/.test(raw)
    ? 'International number detected. We’ll use it as entered.'
    : selected === 'other'
      ? 'Enter the calling code above and your local number here.'
      : 'Enter your number without the first 0 or country code.';
}
function renderEstimate() {
  const amount = Number($('#amount').value);
  const rate = Number(state.offer?.rate);
  $('#receive').textContent = Number.isFinite(amount * rate) ? '$' + money(amount * rate) : '$0.00';
}
async function loadOffer() {
  try {
    state.offer = await api('/api/public/offer');
    $('#rate').textContent = state.offer.rate ? '1 USDT = ' + money(state.offer.rate, 4) + ' USD' : 'Not configured';
    $('#limits').textContent = state.offer.minUsdt ? money(state.offer.minUsdt, 0) + '–' + money(state.offer.maxUsdt, 0) + ' USDT' : '—';
    $('#availability').textContent = state.offer.available ? 'Requests are open. Review today’s rate below.' : 'Exchange requests are temporarily paused.';
    $('#quoteBtn').disabled = !state.offer.available;
    renderEstimate();
  } catch (e) { $('#availability').textContent = 'The current offer could not be loaded. Please try again shortly.'; error(e.message); }
}
$('#amount').addEventListener('input', renderEstimate);
$('#whatsapp').addEventListener('input', updateWhatsappPreview);
$('#whatsappCountry').addEventListener('change', () => {
  $('#customDialWrap').classList.toggle('hidden', $('#whatsappCountry').value !== 'other');
  const examples = { '+252': '61 168 0998', '+254': '712 345 678', '+251': '91 234 5678', '+253': '77 12 34 56', '+255': '712 345 678', '+256': '712 345 678', '+211': '912 345 678', '+249': '91 234 5678', '+967': '71 234 5678', '+971': '50 123 4567', '+966': '50 123 4567', '+974': '3312 3456', '+44': '7400 123456', '+1': '202 555 0123', '+47': '412 34 567', '+46': '70 123 45 67', '+31': '6 12345678', '+49': '1512 3456789', '+90': '532 123 45 67' };
  $('#whatsapp').placeholder = examples[$('#whatsappCountry').value] || 'Enter local number';
  updateWhatsappPreview();
  if ($('#whatsappCountry').value === 'other') $('#customDialCode').focus();
});
$('#customDialCode').addEventListener('input', updateWhatsappPreview);
$('#quoteBtn').addEventListener('click', async () => {
  error(); const button = $('#quoteBtn'); loading(button, true, 'Securing quote…');
  try {
    const result = await api('/api/public/quote', { method: 'POST', body: JSON.stringify({ amount: $('#amount').value }) });
    state.quoteToken = result.quoteToken; state.quote = result; showStep(2);
  } catch (e) { error(e.message, e.field); }
  finally { loading(button, false); button.disabled = !state.offer?.available; }
});
$('#otpBtn').addEventListener('click', async () => {
  error(); const button = $('#otpBtn'); loading(button, true, 'Sending code…');
  try {
    const result = await api('/api/requests/otp', { method: 'POST', body: JSON.stringify(contact()) });
    $('#otpEmail').textContent = result.email; showStep(3); startCooldown(result.resendAfterSeconds || 60); $('#otp').focus();
  } catch (e) { error(e.message, e.field); }
  finally { loading(button, false); }
});
$('#verifyBtn').addEventListener('click', async () => {
  error(); const button = $('#verifyBtn'); loading(button, true, 'Verifying…');
  try {
    const result = await api('/api/requests/verify', { method: 'POST', body: JSON.stringify({ ...contact(), otp: $('#otp').value }) });
    $('#reference').textContent = result.reference;
    $('#confirmedQuote').textContent = result.amount + ' USDT at ' + result.rate + ' = ' + money(result.receiveUsd) + ' Money Go USD';
    showStep(4);
  } catch (e) {
    error(e.message, e.field);
    if (e.code === 'QUOTE_EXPIRED' || e.code === 'QUOTE_INVALID') setTimeout(() => showStep(1), 1800);
  } finally { loading(button, false); }
});
$('#resendBtn').addEventListener('click', async () => {
  const button = $('#resendBtn'); loading(button, true, 'Sending…');
  try { const result = await api('/api/requests/otp', { method: 'POST', body: JSON.stringify(contact()) }); startCooldown(result.resendAfterSeconds || 60); error('A new code was sent.'); }
  catch (e) { error(e.message, e.field); }
  finally { loading(button, false); }
});
$$('[data-back]').forEach((button) => button.addEventListener('click', () => { error(); showStep(Number(button.dataset.back)); }));
$('#newBtn').addEventListener('click', () => location.reload());
function startCooldown(seconds) {
  state.resendUntil = Date.now() + seconds * 1000;
  const button = $('#resendBtn');
  const tick = () => {
    const left = Math.max(0, Math.ceil((state.resendUntil - Date.now()) / 1000));
    button.disabled = left > 0;
    button.textContent = left ? 'Resend in ' + left + 's' : 'Resend code';
    if (left) setTimeout(tick, 1000);
  };
  tick();
}
loadOffer();
