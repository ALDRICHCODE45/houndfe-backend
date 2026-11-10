/**
 * The real application graph compiles and the optional wrapper hook is
 * actually injected into the legacy flows (unit 3). Their own specs build
 * them without it, so this is the proof that production keeps wrapping.
 */
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { ReceiptUploadService } from '../receipts/application/receipt-upload.service';
import { ReceiptReviewService } from '../sales/review/receipt-review.service';
import { CHATBOT_REQUEST_RESOLVER } from './application/chatbot-request-commands.service';
import { ChatbotRequestWrapper } from './infrastructure/chatbot-request-wrapper';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

describeIfDb('chatbot request wiring (real application graph)', () => {
  it('injects one wrapper into the flows and binds the resolver', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    try {
      const wrapper = moduleRef.get(ChatbotRequestWrapper, { strict: false });
      const wrapperOf = (target: object) =>
        (target as { wrapper?: ChatbotRequestWrapper }).wrapper;
      expect(
        wrapperOf(moduleRef.get(ReceiptUploadService, { strict: false })),
      ).toBe(wrapper);
      expect(
        wrapperOf(moduleRef.get(ReceiptReviewService, { strict: false })),
      ).toBe(wrapper);
      expect(
        moduleRef.get(CHATBOT_REQUEST_RESOLVER, { strict: false }),
      ).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  }, 60_000);
});
