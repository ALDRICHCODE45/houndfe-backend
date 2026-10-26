import { d16Postgres } from './d16-postgres-runner';

it.each([undefined, 'wrong-target'])(
  'rejects selector %s before connection',
  async (selector) => {
    const original = process.env.CATALOG_EDITORIAL_D16_TEST_CONTAINER;
    try {
      if (selector === undefined)
        delete process.env.CATALOG_EDITORIAL_D16_TEST_CONTAINER;
      else process.env.CATALOG_EDITORIAL_D16_TEST_CONTAINER = selector;
      await expect(d16Postgres()).rejects.toThrow(
        'Exact D16 container selection required',
      );
    } finally {
      if (original === undefined)
        delete process.env.CATALOG_EDITORIAL_D16_TEST_CONTAINER;
      else process.env.CATALOG_EDITORIAL_D16_TEST_CONTAINER = original;
    }
  },
);
