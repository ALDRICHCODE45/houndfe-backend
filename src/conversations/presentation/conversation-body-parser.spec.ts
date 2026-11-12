/**
 * A full `messages:batch` is 50 messages of up to 4 096 characters. Raw UTF-8
 * that is ~200 KB, but a JSON encoder that escapes non-ASCII as `\uXXXX` writes
 * 6 bytes per BMP character and 12 per astral one (an emoji is a surrogate
 * pair): the worst case is 50 x 4 096 x 12 = 2.46 MB. Express's default limit is
 * 100 KB, and its errors do not carry the bot's envelope. The installer gives
 * ONLY that route a 3 MiB limit and answers its parse errors in the bot's
 * `{statusCode, code, message}` envelope, never echoing the body.
 */
import express from 'express';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import {
  CONVERSATION_BATCH_BODY_BYTES,
  installConversationBatchBodyParser,
} from './conversation-body-parser';

const build = (withInstaller: boolean) => {
  const app = express();
  if (withInstaller) {
    installConversationBatchBodyParser(app as unknown as INestApplication);
  }
  // What Nest mounts later: the default parser.
  app.use(express.json());
  app.post(/.*/, (req, res) => {
    res.json({ bytes: JSON.stringify(req.body).length });
  });
  return app;
};
const big = { messages: [{ text: 'a'.repeat(300_000) }] };
/** 50 messages of 4 096 emoji, each escaped as a surrogate pair: 12 bytes. */
const escapedWorstCase = () => {
  const text = '\\ud83d\\ude00'.repeat(4096);
  const message = `{"waMessageId":"wamid.X","direction":"IN","type":"TEXT","text":"${text}"}`;
  return `{"messages":[${Array.from({ length: 50 }, () => message).join(',')}]}`;
};
const ROUTE = '/chatbot-api/conversations/wa%3A5215512345678/messages:batch';

describe('installConversationBatchBodyParser', () => {
  it('without it the default 100 KB limit refuses a full batch', async () => {
    await request(build(false)).post(ROUTE).send(big).expect(413);
  });

  it('lets the batch route take a full batch even when every character is \\uXXXX-escaped (2.46 MB)', async () => {
    const body = escapedWorstCase();
    expect(Buffer.byteLength(body)).toBeGreaterThan(2_400_000);
    expect(Buffer.byteLength(body)).toBeLessThan(CONVERSATION_BATCH_BODY_BYTES);
    await request(build(true))
      .post(ROUTE)
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
  });

  it('the documented bound is exactly 3 MiB (3 145 728 bytes)', () => {
    expect(CONVERSATION_BATCH_BODY_BYTES).toBe(3 * 1024 * 1024);
  });

  it('still refuses more than the bound on that route, in the bot envelope', async () => {
    const res = await request(build(true))
      .post(ROUTE)
      .send({ messages: [{ text: 'a'.repeat(3_300_000) }] })
      .expect(413);
    expect(res.body).toEqual<unknown>({
      statusCode: 413,
      code: 'BODY_TOO_LARGE',
      message: expect.any(String) as unknown,
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toContain('aaaa');
  });

  it('answers malformed JSON in the bot envelope and never echoes the body', async () => {
    const res = await request(build(true))
      .post(ROUTE)
      .set('Content-Type', 'application/json')
      .send('{"messages":[{"text":"secreto-5215512345678", oops')
      .expect(400);
    expect(res.body).toEqual<unknown>({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: expect.any(String) as unknown,
    });
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    const raw = JSON.stringify(res.body) + res.text;
    expect(raw).not.toContain('secreto');
    expect(raw).not.toContain('5215512345678');
    expect(raw).not.toMatch(/SyntaxError|Unexpected|position|at \w+/);
  });

  it('answers a body whose declared encoding is broken in the same envelope', async () => {
    const res = await request(build(true))
      .post(ROUTE)
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send('this is not gzip')
      .expect(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('leaves every other route on the default limit', async () => {
    await request(build(true))
      .post('/chatbot-api/requests')
      .send(big)
      .expect(413);
    await request(build(true))
      .post('/chatbot-api/messages/statuses:batch')
      .send(big)
      .expect(413);
  });
});
