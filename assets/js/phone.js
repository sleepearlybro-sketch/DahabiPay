export function composeWhatsapp(rawValue, selectedCode, customCode = '') {
  const raw = String(rawValue ?? '').trim();
  if (/^\+/.test(raw)) return '+' + raw.replace(/\D/g, '');
  if (/^00/.test(raw)) return '+' + raw.replace(/\D/g, '').slice(2);

  const prefix = selectedCode === 'other' ? String(customCode).trim() : String(selectedCode || '').trim();
  if (!/^\+[1-9]\d{0,2}$/.test(prefix)) return '';
  let national = raw.replace(/\D/g, '').replace(/^0+/, '');
  const prefixDigits = prefix.slice(1);
  if (national.startsWith(prefixDigits) && national.length > prefixDigits.length + 7) {
    national = national.slice(prefixDigits.length);
  }
  return prefix + national;
}
