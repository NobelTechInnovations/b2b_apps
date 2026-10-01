import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMailer, parseAddress } from '../services/notifier/src/lib/email.js';

/** A stand-in for ZeptoMail's API that records what it was sent. */
async function fakeZepto(status, reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1.1/email`, seen, close: () => server.close() };
}

test('a sender name and address are read from MAIL_FROM', () => {
  assert.deepEqual(parseAddress('FLP Worldwide <noreply@flpworldwide.com>'), { name: 'FLP Worldwide', address: 'noreply@flpworldwide.com' });
  assert.deepEqual(parseAddress('noreply@flpworldwide.com'), { name: null, address: 'noreply@flpworldwide.com' });
});

test('with a ZeptoMail token, mail goes over HTTPS instead of SMTP', async () => {
  const zepto = await fakeZepto(201, { data: [{ code: 'EM_104', message: 'Email request received' }], message: 'OK', request_id: 'req-1' });
  try {
    const mailer = createMailer({ zeptomailToken: 'secret-token', mailFrom: 'FLP Worldwide <noreply@flpworldwide.com>', zeptomailApiUrl: zepto.url, smtpHost: 'smtp.zeptomail.in' });
    assert.match(mailer.label, /^ZeptoMail API/);
    const result = await mailer.send({ to: 'asha@flpworldwide.com', subject: 'Hello', text: 'Hi', html: '<p>Hi</p>' });
    assert.equal(result.messageId, 'req-1');
    assert.match(result.response, /^201 Email request received/);
    const [call] = zepto.seen;
    assert.equal(call.headers.authorization, 'Zoho-enczapikey secret-token');
    assert.deepEqual(call.body.from, { address: 'noreply@flpworldwide.com', name: 'FLP Worldwide' });
    assert.deepEqual(call.body.to, [{ email_address: { address: 'asha@flpworldwide.com' } }]);
    assert.equal(call.body.htmlbody, '<p>Hi</p>');
  } finally {
    zepto.close();
  }
});

test('a rejected request is final; a server error may be retried', async () => {
  const refused = await fakeZepto(400, { error: { code: 'TM_3201', message: 'Mandatory Field missing', details: [{ target: 'from', message: 'Sender address not verified' }] } });
  try {
    const mailer = createMailer({ zeptomailToken: 'Zoho-enczapikey abc', mailFrom: 'noreply@flp.com', zeptomailApiUrl: refused.url });
    await assert.rejects(mailer.send({ to: 'a@b.com', subject: 's', text: 't', html: 'h' }), (error) => {
      assert.equal(error.permanent, true);
      assert.match(error.message, /from: Sender address not verified/);
      return true;
    });
    assert.equal(refused.seen[0].headers.authorization, 'Zoho-enczapikey abc', 'a pasted prefix is not doubled');
  } finally {
    refused.close();
  }
  const down = await fakeZepto(503, {});
  try {
    const mailer = createMailer({ zeptomailToken: 'abc', mailFrom: 'noreply@flp.com', zeptomailApiUrl: down.url });
    await assert.rejects(mailer.send({ to: 'a@b.com', subject: 's', text: 't', html: 'h' }), (error) => error.permanent === false);
  } finally {
    down.close();
  }
});

test('EMAIL_PROVIDER=smtp keeps SMTP even when a token is present; nothing set means log only', () => {
  assert.match(createMailer({ zeptomailToken: 'abc', emailProvider: 'smtp', smtpHost: 'smtp.zeptomail.in', smtpPort: 587, mailFrom: 'x@y.com' }).label, /^smtp\.zeptomail\.in:587$/);
  assert.equal(createMailer({ mailFrom: 'x@y.com' }), null);
});
