import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeWhatsapp } from '../../assets/js/phone.js';

const callingCountries = JSON.parse(readFileSync(new URL('../../assets/js/countries.json', import.meta.url), 'utf8'));

test('searchable calling-code data covers 240+ unique regions and includes Somalia', () => {
  assert.ok(callingCountries.length >= 240);
  assert.equal(new Set(callingCountries.map(({ code }) => code)).size, callingCountries.length);
  assert.ok(callingCountries.every(({ dial }) => /^\+[1-9]\d{0,2}$/.test(dial)));
  assert.equal(callingCountries[0].code, 'SO');
});

test('WhatsApp local numbers use the selected country calling code', () => {
  assert.equal(composeWhatsapp('611 680 998', '+252'), '+252611680998');
  assert.equal(composeWhatsapp('0712 345 678', '+254'), '+254712345678');
});

test('WhatsApp international numbers pasted by the customer are preserved', () => {
  assert.equal(composeWhatsapp('+44 (7400) 123456', '+252'), '+447400123456');
  assert.equal(composeWhatsapp('0049 1512 3456789', '+252'), '+4915123456789');
});

test('any selected international calling code is used for a local number', () => {
  assert.equal(composeWhatsapp('6 12 34 56 78', '+33'), '+33612345678');
  assert.equal(composeWhatsapp('612 345 678', ''), '');
});
