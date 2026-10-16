import { composeWhatsapp } from './phone.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const state = { offer: null, quoteToken: '', quote: null, step: 1, resendUntil: 0, customer: null, authEmail: '', countries: [], filteredCountries: [] };
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
  return { fullName: $('#fullName').value, email: state.customer?.email || $('#email').value, whatsapp: normalizedWhatsapp(), moneygoAccount: $('#moneygoAccount').value, note: $('#note').value, quoteToken: state.quoteToken };
}
function normalizedWhatsapp() {
  return composeWhatsapp($('#whatsapp').value, $('#whatsappCountry').value);
}
function updateWhatsappPreview() {
  const raw = $('#whatsapp').value.trim();
  const preview = normalizedWhatsapp();
  $('#whatsappPreview').textContent = preview || $('#whatsappCountry').value;
  $('#whatsappPreview').classList.toggle('phone-preview--invalid', Boolean(raw && !/^\+[1-9]\d{7,14}$/.test(preview)));
  $('#whatsappHelpText').textContent = /^\+|^00/.test(raw)
    ? 'International number detected. We’ll use it as entered.'
    : 'Enter your number without the first 0 or country code.';
}
const flag = (code) => [...code.toUpperCase()].map((letter) => String.fromCodePoint(letter.charCodeAt(0) + 127397)).join('');
function renderCountries(query = '') {
  const terms = query.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  state.filteredCountries = state.countries.filter((country) => !terms || `${country.name} ${country.code} ${country.dial}`.toLocaleLowerCase().includes(terms));
  const options = $('#countryOptions');
  options.replaceChildren();
  for (const country of state.filteredCountries) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'country-picker__option'; button.id = `country-${country.code}`;
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', country.dial === $('#whatsappCountry').value && country.code === $('#whatsappCountry').dataset.country);
    const label = document.createElement('span'); label.textContent = `${flag(country.code)} ${country.name}`;
    const dial = document.createElement('strong'); dial.textContent = country.dial;
    button.append(label, dial);
    button.addEventListener('click', () => selectCountry(country));
    options.append(button);
  }
  $('#countryEmpty').classList.toggle('hidden', state.filteredCountries.length > 0);
}
function openCountryPicker() {
  $('#countryPicker').classList.remove('hidden');
  $('#countryPickerButton').setAttribute('aria-expanded', 'true');
  $('#countrySearch').value = '';
  renderCountries();
  $('#countrySearch').focus();
}
function closeCountryPicker() {
  $('#countryPicker').classList.add('hidden');
  $('#countryPickerButton').setAttribute('aria-expanded', 'false');
}
function selectCountry(country) {
  $('#whatsappCountry').value = country.dial;
  $('#whatsappCountry').dataset.country = country.code;
  $('#selectedCountry').textContent = `${flag(country.code)} ${country.name} ${country.dial}`;
  $('#whatsapp').placeholder = country.code === 'SO' ? '61 168 0998' : country.code === 'KE' ? '712 345 678' : 'Enter local number';
  closeCountryPicker(); updateWhatsappPreview(); $('#whatsapp').focus();
}
async function loadCountries() {
  const response = await fetch('/assets/js/countries.json');
  if (!response.ok) throw new Error('Country calling codes could not be loaded');
  state.countries = await response.json();
  renderCountries();
  const somalia = state.countries.find((country) => country.code === 'SO');
  if (somalia) selectCountry(somalia);
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
$('#countryPickerButton').addEventListener('click', () => $('#countryPicker').classList.contains('hidden') ? openCountryPicker() : closeCountryPicker());
$('#countrySearch').addEventListener('input', (event) => renderCountries(event.target.value));
$('#countrySearch').addEventListener('keydown', (event) => {
  const buttons = $$('.country-picker__option');
  if (event.key === 'Escape') { event.preventDefault(); closeCountryPicker(); $('#countryPickerButton').focus(); }
  if (event.key === 'ArrowDown' && buttons.length) { event.preventDefault(); buttons[0].focus(); }
  if (event.key === 'Enter' && buttons.length === 1) { event.preventDefault(); buttons[0].click(); }
});
$('#countryOptions').addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = $$('.country-picker__option');
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault(); buttons[next].focus();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || $('#countryPicker').classList.contains('hidden')) return;
  closeCountryPicker(); $('#countryPickerButton').focus();
});
document.addEventListener('click', (event) => {
  if (!$('#countryPicker').contains(event.target) && !$('#countryPickerButton').contains(event.target)) closeCountryPicker();
});
$('#quoteBtn').addEventListener('click', async () => {
  error(); const button = $('#quoteBtn'); loading(button, true, 'Securing quote…');
  try {
    const result = await api('/api/public/quote', { method: 'POST', body: JSON.stringify({ amount: $('#amount').value }) });
    state.quoteToken = result.quoteToken; state.quote = result; showStep(2);
  } catch (e) { error(e.message, e.field); }
  finally { loading(button, false); button.disabled = !state.offer?.available; }
});
$('#otpBtn').addEventListener('click', async () => {
  error(); const button = $('#otpBtn'); loading(button, true, state.customer ? 'Reviewing…' : 'Sending code…');
  try {
    const details = contact();
    if (details.fullName.trim().length < 2) throw Object.assign(new Error('Enter your full name'), { field: 'fullName' });
    if (!/^\+[1-9]\d{7,14}$/.test(details.whatsapp)) throw Object.assign(new Error('Enter a valid WhatsApp number with a country code'), { field: 'whatsapp' });
    if (details.moneygoAccount.trim().length < 5) throw Object.assign(new Error('Enter your Money Go account ID or number'), { field: 'moneygoAccount' });
    if (state.customer) { showReview(); return; }
    state.authEmail = details.email.trim().toLowerCase();
    const result = await api('/api/customer/auth/otp', { method: 'POST', body: JSON.stringify({ email: state.authEmail }) });
    $('#otpEmail').textContent = result.email; showStep(3); startCooldown(result.resendAfterSeconds || 60); $('#otp').focus();
  } catch (e) { error(e.message, e.field); }
  finally { loading(button, false); }
});
$('#verifyBtn').addEventListener('click', async () => {
  error(); const button = $('#verifyBtn'); loading(button, true, 'Verifying…');
  try {
    const result = await api('/api/customer/auth/verify', { method: 'POST', body: JSON.stringify({ email: state.authEmail, otp: $('#otp').value }) });
    state.customer = result.customer;
    setSignedIn(); showReview();
  } catch (e) { error(e.message, e.field); }
  finally { loading(button, false); }
});
$('#resendBtn').addEventListener('click', async () => {
  const button = $('#resendBtn'); loading(button, true, 'Sending…');
  try { const result = await api('/api/customer/auth/otp', { method: 'POST', body: JSON.stringify({ email: state.authEmail }) }); startCooldown(result.resendAfterSeconds || 60); error('A new email code was sent.'); }
  catch (e) { error(e.message, e.field); }
  finally { loading(button, false); button.disabled = Date.now() < state.resendUntil; }
});
function setSignedIn() {
  $('#email').value = state.customer.email;
  $('#email').readOnly = true;
  $('#emailHint').textContent = 'Signed in. Your requests are saved to this email account.';
  $('#otpBtn').textContent = 'Review request';
  $('#otpBtn').dataset.label = 'Review request';
}
function showReview() {
  const details = contact();
  $('#reviewQuote').textContent = `${state.quote.amount} USDT → ${money(state.quote.receiveUsd)} Money Go USD`;
  $('#reviewName').textContent = details.fullName.trim();
  $('#reviewEmail').textContent = details.email;
  $('#reviewWhatsapp').textContent = details.whatsapp;
  $('#reviewMoneygo').textContent = details.moneygoAccount.trim();
  showStep(4);
}
$('#submitBtn').addEventListener('click', async () => {
  error(); const button = $('#submitBtn'); loading(button, true, 'Submitting…');
  try {
    const result = await api('/api/requests', { method: 'POST', body: JSON.stringify(contact()) });
    $('#reference').textContent = result.reference;
    $('#confirmedQuote').textContent = `${result.amount} USDT at ${result.rate} = ${money(result.receiveUsd)} Money Go USD`;
    showStep(5);
  } catch (e) {
    error(e.message, e.field);
    if (e.code === 'QUOTE_EXPIRED' || e.code === 'QUOTE_INVALID') setTimeout(() => showStep(1), 2000);
    if (e.status === 401) location.href = '/account/';
  } finally { loading(button, false); }
});
$$('[data-back]').forEach((button) => button.addEventListener('click', () => { error(); showStep(Number(button.dataset.back)); }));
$('#newBtn').addEventListener('click', () => location.reload());
function startCooldown(seconds) {
  state.resendUntil = Date.now() + seconds * 1000;
  const button = $('#resendBtn');
  const tick = () => {
    const left = Math.max(0, Math.ceil((state.resendUntil - Date.now()) / 1000));
    button.disabled = left > 0;
    button.dataset.label = left ? 'Resend in ' + left + 's' : 'Resend code';
    button.textContent = button.dataset.label;
    if (left) setTimeout(tick, 1000);
  };
  tick();
}
loadCountries().catch(() => { $('#whatsappHelpText').textContent = 'Calling codes could not load. Refresh and try again.'; $('#otpBtn').disabled = true; });
loadOffer();
api('/api/customer/me').then((result) => { state.customer = result.customer; setSignedIn(); }).catch(() => {});
