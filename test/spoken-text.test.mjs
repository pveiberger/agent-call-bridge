import assert from 'node:assert/strict';
import test from 'node:test';
import { spokenText } from '../bridge/spoken-text.mjs';

test('task status, dates, numbers and negation survive Markdown-to-speech', () => {
  const id = '2d7caa075d344580ad5ddc3691028b78';
  const page = 'https://www.notion.so/' + id + '?view=(privat)';
  const reply = [
    '## Deine Aufgaben',
    '- [x] **[Arzttermin](' + page + ' "Meine Planung")** am 27.11.2026.',
    '- [ ] _Heizung_ bei -3,5 °C **nicht** abschalten.',
    '2*3*4 = 24. Konto: -15,20 €. Siehe (' + page + ').',
  ].join('\n');
  assert.equal(
    spokenText(reply),
    [
      'Deine Aufgaben',
      'Erledigt: Arzttermin am 27.11.2026.',
      'Offen: Heizung bei -3,5 °C nicht abschalten.',
      '2*3*4 = 24. Konto: -15,20 €. Siehe (Link im Chat).',
    ].join('\n'),
  );
  assert.ok(reply.includes(id), 'original chat content retains the link');
});

test('reference links and autolinks keep descriptive labels or a short spoken placeholder', () => {
  const url = 'https://example.org/users/bf922893-48dc-4503-b499-d1ff5c259893';
  const original = [
    '[Einkauf][Aufgaben], [' + url + '](' + url + '), <' + url + '>.',
    '![Plan [November]](' + url + ') und **' + url + '**.',
    '[Aufgaben]: ' + url,
  ].join('\n');
  assert.equal(
    spokenText(original),
    'Einkauf, Link im Chat, Link im Chat.\nPlan [November] und Link im Chat.',
  );
  assert.equal(
    spokenText('[bf922893-48dc-4503-b499-d1ff5c259893](' + url + ')'),
    'Link im Chat',
  );
  assert.equal(
    spokenText(
      'Privater Plan: notion.so/bf92289348dc4503b499d1ff5c259893, siehe example.org.',
    ),
    'Privater Plan: Link im Chat, siehe Link im Chat.',
  );
  assert.equal(
    spokenText('Sende eine Mail an team@example.org.'),
    'Sende eine Mail an team@example.org.',
  );
});

test('plain replies, code contents and standalone negative numbers retain their meaning', () => {
  assert.equal(
    spokenText('Nein, das waren -25 und nicht 25.'),
    'Nein, das waren -25 und nicht 25.',
  );
  assert.equal(spokenText('- 5 Grad Celsius'), '- 5 Grad Celsius');
  const fence = '```';
  assert.equal(spokenText(fence + 'js\nreturn -42;\n' + fence), 'return -42;');
  assert.equal(
    spokenText('Rechne mit ' + fence + '-42' + fence + '.'),
    'Rechne mit -42.',
  );
});
