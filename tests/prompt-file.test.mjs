import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import { promptFromFile } from '../extension/lib/prompt-file.js';

test('plain text and markdown are themselves', async () => {
  assert.equal(await promptFromFile('style.txt', '  Be brief.  '), 'Be brief.');
  assert.equal(await promptFromFile('style.md', '# House style\n\nShort lines.'), '# House style\n\nShort lines.');
});

test('a json string is the prompt', async () => {
  assert.equal(await promptFromFile('prompt.json', '"You are terse."'), 'You are terse.');
});

test('a json object exposes its prompt field', async () => {
  const file = JSON.stringify({ name: 'House', systemPrompt: 'Answer in British English.' });
  assert.equal(await promptFromFile('prompt.json', file), 'Answer in British English.');
});

test('a json object without a prompt field still yields its text', async () => {
  const file = JSON.stringify({ persona: { tone: 'wry' }, rules: ['no emoji', 'no filler'] });
  assert.equal(await promptFromFile('prompt.json', file), 'wry\nno emoji\nno filler');
});

test('invalid json is refused with a readable reason', async () => {
  await assert.rejects(() => promptFromFile('prompt.json', '{oops'), /not valid JSON/);
});

test('html is reduced to its text, without scripts or tags', async () => {
  const html =
    '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>Rules</h1><p>Be&nbsp;kind &amp; brief.</p></body></html>';
  const text = await promptFromFile('prompt.html', html);
  assert.equal(text, 'Rules\nBe kind & brief.');
  assert.ok(!text.includes('alert'));
});

test('a pdf is read from its text layer', async () => {
  const content = 'Be brief and kind. Answer in one paragraph.';
  const stream = deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${content}) Tj ET`, 'latin1'));
  const head = Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`,
    'latin1',
  );
  const tail = Buffer.from('\nendstream\nendobj\ntrailer\n<<>>\n%%EOF', 'latin1');
  const bytes = new Uint8Array(Buffer.concat([head, stream, tail]));

  const text = await promptFromFile('brief.pdf', bytes.buffer);
  assert.match(text, /Be brief and kind\. Answer in one paragraph\./);
});

test('an uncompressed pdf stream is read too', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.4\nstream\nBT (Always answer in haiku.) Tj ET\nendstream\n%%EOF');
  assert.match(await promptFromFile('haiku.pdf', bytes.buffer), /Always answer in haiku\./);
});

test('a pdf with no text layer is refused honestly rather than parsed badly', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.4\nstream\nGARBAGE\nendstream\n%%EOF');
  await assert.rejects(() => promptFromFile('scan.pdf', bytes.buffer), /No readable text layer/);
});

test('something that is not a pdf is refused', async () => {
  const bytes = new TextEncoder().encode('hello');
  await assert.rejects(() => promptFromFile('thing.pdf', bytes.buffer), /does not start like a PDF/);
});

test('an unknown extension is refused', async () => {
  await assert.rejects(() => promptFromFile('brief.docx', 'x'), /\.txt, \.md, \.json, \.html or \.pdf/);
});
