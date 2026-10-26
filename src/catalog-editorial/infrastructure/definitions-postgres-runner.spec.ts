import { definitionsPostgres } from './definitions-postgres-runner';

describe('definitions test target admission', () => {
  const original = process.env.CATALOG_EDITORIAL_DEFINITIONS_TEST_CONTAINER;
  afterEach(() => {
    if (original === undefined)
      delete process.env.CATALOG_EDITORIAL_DEFINITIONS_TEST_CONTAINER;
    else process.env.CATALOG_EDITORIAL_DEFINITIONS_TEST_CONTAINER = original;
  });
  it.each([undefined, 'wrong-target'])(
    'rejects selector %s before connecting',
    async (selector) => {
      if (selector === undefined)
        delete process.env.CATALOG_EDITORIAL_DEFINITIONS_TEST_CONTAINER;
      else process.env.CATALOG_EDITORIAL_DEFINITIONS_TEST_CONTAINER = selector;
      await expect(definitionsPostgres()).rejects.toThrow(
        'Exact definitions container selection required',
      );
    },
  );
});
