import type { INestApplication } from '@nestjs/common';
import type { Request, RequestHandler, Response } from 'express';
import { installPurchaseOrderBodyParser } from './po-body-parser';

function harness() {
  const handlers: RequestHandler[] = [];
  const app = {
    use: (handler: RequestHandler) => handlers.push(handler),
  } as unknown as INestApplication;
  installPurchaseOrderBodyParser(app);
  const response = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const next = jest.fn();
  const run = (method: string, path: string) =>
    handlers[0](
      { method, originalUrl: `${path}?ignored=1`, path } as Request,
      response as unknown as Response,
      next,
    );
  return { run, response, next };
}

describe('PO early parser exact admission scope', () => {
  it.each([
    ['GET', '/procurement/purchase-orders/%E0%A4%A'],
    ['HEAD', '/PROCUREMENT/PURCHASE-ORDERS/%E0%A4%A/'],
    ['DELETE', '/procurement/purchase-orders/%E0%A4%A'],
    ['PUT', '/Procurement/Purchase-Orders/%E0%A4%A/draft/'],
    ['POST', '/procurement/purchase-orders/%E0%A4%A/confirm'],
    ['POST', '/Procurement/Purchase-Orders/%E0%A4%A/cancel/'],
  ])('closes invalid encoded parameter on %s %s', (method, path) => {
    const h = harness();
    h.run(method, path);
    expect(h.response.status).toHaveBeenCalledWith(400);
    expect(h.response.json).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'MALFORMED',
    });
    expect(h.response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect(h.next).not.toHaveBeenCalled();
  });
  it.each([
    ['POST', '/procurement/purchase-orders/%E0%A4%A'],
    ['PATCH', '/procurement/purchase-orders/%E0%A4%A'],
    ['DELETE', '/procurement/purchase-orders'],
    ['PUT', '/procurement/purchase-orders'],
    ['GET', '/procurement/purchase-orders/%E0%A4%A/history'],
    ['PUT', '/procurement/purchase-orders/%E0%A4%A/draft-extra'],
    ['PUT', '/procurement/purchase-orders/%E0%A4%A/confirm'],
    ['GET', '/procurement/purchase-orders/%E0%A4%A/cancel'],
    ['POST', '/procurement/purchase-orders/%E0%A4%A/confirm-extra'],
    ['POST', '/procurement/purchase-orders/%E0%A4%A/history'],
    ['GET', '/procurement/purchase-orders-extra/%E0%A4%A'],
    ['GET', '/procurement/suppliers/%E0%A4%A'],
    ['POST', '/unrelated/%E0%A4%A'],
  ])('leaves non-PO/unsupported %s %s untouched', (method, path) => {
    const h = harness();
    h.run(method, path);
    expect(h.next).toHaveBeenCalledWith();
    expect(h.response.status).not.toHaveBeenCalled();
    expect(h.response.json).not.toHaveBeenCalled();
  });
});
