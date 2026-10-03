import test from 'node:test';
import assert from 'node:assert/strict';
import { composeWhatsapp } from '../../assets/js/phone.js';

test('WhatsApp local numbers use the selected country calling code', () => {
  assert.equal(composeWhatsapp('611 680 998', '+252'), '+252611680998');
  assert.equal(composeWhatsapp('0712 345 678', '+254'), '+254712345678');
});

test('WhatsApp international numbers pasted by the customer are preserved', () => {
  assert.equal(composeWhatsapp('+44 (7400) 123456', '+252'), '+447400123456');
  assert.equal(composeWhatsapp('0049 1512 3456789', '+252'), '+4915123456789');
});

test('other country dialing codes must be explicitly supplied', () => {
  assert.equal(composeWhatsapp('612 345 678', 'other', '+33'), '+33612345678');
  assert.equal(composeWhatsapp('612 345 678', 'other'), '');
});
