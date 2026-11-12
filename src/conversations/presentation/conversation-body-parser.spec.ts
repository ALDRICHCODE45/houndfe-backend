/**
 * A full `messages:batch` (50 messages of up to 4 096 characters) is about
 * 200 KB of JSON, above Express's 100 KB default body limit, so the global
 * parser would answer a 413 with a body the bot does not know. The installer
 * gives ONLY that route a 1 MB limit.
 */
import express from 'express';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { installConversationBatchBodyParser } from './conversation-body-parser';

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
const ROUTE = '/chatbot-api/conversations/wa%3A5215512345678/messages:batch';

describe('installConversationBatchBodyParser', () => {
  it('without it the default 100 KB limit refuses a full batch', async () => {
    await request(build(false)).post(ROUTE).send(big).expect(413);
  });

  it('lets the batch route take up to 1 MB', async () => {
    await request(build(true)).post(ROUTE).send(big).expect(200);
  });

  it('still refuses more than 1 MB on that route', async () => {
    await request(build(true))
      .post(ROUTE)
      .send({ messages: [{ text: 'a'.repeat(1_200_000) }] })
      .expect(413);
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
