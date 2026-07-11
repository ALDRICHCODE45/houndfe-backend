import { Sale } from './sale.entity';
import {
  InvalidArgumentError,
  BusinessRuleViolationError,
} from '../../shared/domain/domain-error';
import {
  InvalidDueDateError,
  SaleDeliveredCannotCancelError,
  SaleNotCancellableError,
} from './sale.errors';

const BASE_SALE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = '550e8400-e29b-41d4-a716-446655440001';

describe('Sale Entity', () => {
  describe('create - create new DRAFT sale', () => {
    it('should create a DRAFT sale with required fields', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      expect(sale.id).toBe(BASE_SALE_ID);
      expect(sale.userId).toBe(USER_ID);
      expect(sale.status).toBe('DRAFT');
      expect(sale.items).toEqual([]);
    });

    it('should throw InvalidArgumentError if userId is empty', () => {
      expect(() =>
        Sale.create({
          id: BASE_SALE_ID,
          userId: '',
        }),
      ).toThrow(InvalidArgumentError);
    });

    it('should throw InvalidArgumentError if id is empty', () => {
      expect(() =>
        Sale.create({
          id: '',
          userId: USER_ID,
        }),
      ).toThrow(InvalidArgumentError);
    });
  });

  describe('fromPersistence - reconstitute from database', () => {
    it('should reconstitute sale with empty items', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'DRAFT',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(sale.id).toBe(BASE_SALE_ID);
      expect(sale.userId).toBe(USER_ID);
      expect(sale.status).toBe('DRAFT');
      expect(sale.items).toEqual([]);
    });

    it('should reconstitute sale with existing items', () => {
      const itemData = {
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      };

      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'DRAFT',
        items: [itemData],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(sale.items).toHaveLength(1);
      expect(sale.items[0].productId).toBe('prod-001');
      expect(sale.items[0].quantity).toBe(2);
    });

    it('should reconstitute a confirmed sale with confirmation fields', () => {
      const confirmedAt = new Date('2026-05-06T12:00:00.000Z');

      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        items: [],
        confirmedAt,
        folio: 'A-2605-0001',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(sale.status).toBe('CONFIRMED');
      expect(sale.confirmedAt).toEqual(confirmedAt);
      expect(sale.folio).toBe('A-2605-0001');
    });
  });

  describe('confirm - transition DRAFT to CONFIRMED', () => {
    it('should transition draft sale to confirmed', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });
      const confirmedAt = new Date('2026-05-06T12:00:00.000Z');

      const confirmed = sale.confirm({
        confirmedAt,
        folio: 'A-2605-0001',
      });

      expect(confirmed.status).toBe('CONFIRMED');
      expect(confirmed.confirmedAt).toEqual(confirmedAt);
      expect(confirmed.folio).toBe('A-2605-0001');
    });

    it('should reject confirmation when sale is already confirmed', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        items: [],
        confirmedAt: new Date('2026-05-06T12:00:00.000Z'),
        folio: 'A-2605-0001',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(() =>
        sale.confirm({
          confirmedAt: new Date('2026-05-06T12:01:00.000Z'),
          folio: 'A-2605-0002',
        }),
      ).toThrow(BusinessRuleViolationError);
    });
  });

  describe('cancel - guard requires CONFIRMED status', () => {
    it('rejects canceling a DRAFT sale', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      try {
        sale.cancel('CUSTOMER_REQUEST', { actorId: USER_ID });
        throw new Error('Expected SaleNotCancellableError');
      } catch (error) {
        expect(error).toBeInstanceOf(SaleNotCancellableError);
        expect((error as SaleNotCancellableError).code).toBe(
          'SALE_NOT_CANCELLABLE',
        );
      }
    });

    it('rejects canceling an already CANCELED sale', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CANCELED',
        items: [],
        confirmedAt: new Date('2026-05-06T12:00:00.000Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      try {
        sale.cancel('ORDER_ERROR', { actorId: USER_ID });
        throw new Error('Expected SaleNotCancellableError');
      } catch (error) {
        expect(error).toBeInstanceOf(SaleNotCancellableError);
        expect((error as SaleNotCancellableError).code).toBe(
          'SALE_NOT_CANCELLABLE',
        );
      }
    });
  });

  describe('cancel - delivery guard', () => {
    it('rejects canceling a SHIPPED sale', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        deliveryStatus: 'SHIPPED',
        items: [],
        confirmedAt: new Date('2026-05-06T12:00:00.000Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      try {
        sale.cancel('CUSTOMER_REQUEST', { actorId: USER_ID });
        throw new Error('Expected SaleDeliveredCannotCancelError');
      } catch (error) {
        expect(error).toBeInstanceOf(SaleDeliveredCannotCancelError);
        expect((error as SaleDeliveredCannotCancelError).code).toBe(
          'SALE_DELIVERED_CANNOT_CANCEL',
        );
      }
    });

    it('rejects canceling a DELIVERED sale', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        deliveryStatus: 'DELIVERED',
        items: [],
        confirmedAt: new Date('2026-05-06T12:00:00.000Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      try {
        sale.cancel('ORDER_ERROR', { actorId: USER_ID });
        throw new Error('Expected SaleDeliveredCannotCancelError');
      } catch (error) {
        expect(error).toBeInstanceOf(SaleDeliveredCannotCancelError);
        expect((error as SaleDeliveredCannotCancelError).code).toBe(
          'SALE_DELIVERED_CANNOT_CANCEL',
        );
      }
    });
  });

  describe('cancel - refund computation', () => {
    it('cancels a CREDIT sale with zero refund and cleared debt', () => {
      const canceledAt = new Date('2026-06-23T12:00:00.000Z');
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        deliveryStatus: 'PENDING',
        items: [],
        confirmedAt: new Date('2026-05-06T12:00:00.000Z'),
        folio: 'A-2605-0001',
        paidCents: 0,
        debtCents: 3500,
        paymentStatus: 'CREDIT',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = sale.cancel('CUSTOMER_REQUEST', {
        actorId: USER_ID,
        canceledAt,
      });

      expect(result.refundedCents).toBe(0);
      expect(result.sale.status).toBe('CANCELED');
      expect(result.sale.debtCents).toBe(0);
      expect(result.sale.cancelReason).toBe('CUSTOMER_REQUEST');
      expect(result.sale.canceledByUserId).toBe(USER_ID);
      expect(result.sale.canceledAt).toEqual(canceledAt);
    });

    it('refunds the recorded paid cents for non-CREDIT sales', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        deliveryStatus: 'PENDING',
        items: [],
        confirmedAt: new Date('2026-05-06T12:00:00.000Z'),
        folio: 'A-2605-0002',
        paidCents: 2700,
        debtCents: 800,
        paymentStatus: 'PARTIAL',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = sale.cancel('ORDER_ERROR', { actorId: USER_ID });

      expect(result.refundedCents).toBe(2700);
      expect(result.sale.debtCents).toBe(800);
      expect(result.sale.cancelReason).toBe('ORDER_ERROR');
    });

    it('clears debt when no money was paid even if payment status is not CREDIT', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        deliveryStatus: 'PENDING',
        items: [],
        confirmedAt: new Date('2026-05-06T12:00:00.000Z'),
        folio: 'A-2605-0003',
        paidCents: 0,
        debtCents: 1800,
        paymentStatus: 'PARTIAL',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = sale.cancel('OTHER', { actorId: USER_ID });

      expect(result.refundedCents).toBe(0);
      expect(result.sale.debtCents).toBe(0);
    });
  });

  describe('setDueDate', () => {
    it('sets due date when it is equal or after confirmedAt', () => {
      const confirmedAt = new Date('2026-05-15T18:00:00.000Z');
      const dueDate = new Date('2026-06-01T00:00:00.000Z');
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        items: [],
        confirmedAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sale.setDueDate(dueDate);

      expect(sale.dueDate).toEqual(dueDate);
    });

    it('throws InvalidDueDateError when dueDate is before confirmedAt', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        items: [],
        confirmedAt: new Date('2026-05-15T18:00:00.000Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(() =>
        sale.setDueDate(new Date('2026-04-01T00:00:00.000Z')),
      ).toThrow(InvalidDueDateError);
    });

    it('accepts null and clears dueDate', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        items: [],
        dueDate: new Date('2026-06-10T00:00:00.000Z'),
        confirmedAt: new Date('2026-05-15T18:00:00.000Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sale.setDueDate(null);

      expect(sale.dueDate).toBeNull();
    });
  });

  describe('assignSeller', () => {
    it('assigns seller on DRAFT sale', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.assignSeller('550e8400-e29b-41d4-a716-446655440099');

      expect(sale.sellerUserId).toBe('550e8400-e29b-41d4-a716-446655440099');
    });

    it('assigns seller on CONFIRMED sale', () => {
      const confirmedAt = new Date('2026-05-15T18:00:00.000Z');
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        items: [],
        confirmedAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sale.assignSeller('550e8400-e29b-41d4-a716-446655440088');

      expect(sale.sellerUserId).toBe('550e8400-e29b-41d4-a716-446655440088');
    });

    it('is idempotent when assigning the same seller id', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'DRAFT',
        sellerUserId: '550e8400-e29b-41d4-a716-446655440077',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sale.assignSeller('550e8400-e29b-41d4-a716-446655440077');

      expect(sale.sellerUserId).toBe('550e8400-e29b-41d4-a716-446655440077');
    });
  });

  describe('clearSeller', () => {
    it('clears existing seller assignment', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        sellerUserId: '550e8400-e29b-41d4-a716-446655440066',
        items: [],
        confirmedAt: new Date('2026-05-15T18:00:00.000Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sale.clearSeller();

      expect(sale.sellerUserId).toBeNull();
    });

    it('is idempotent when seller is already null', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.clearSeller();

      expect(sale.sellerUserId).toBeNull();
    });
  });

  describe('assignCustomer', () => {
    it('assigns customer to a DRAFT sale', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.assignCustomer('cust-1');

      expect(sale.customerId).toBe('cust-1');
      expect(sale.shippingAddressId).toBeNull();
    });

    it('clears previous shipping address when assigning a different customer without address', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'DRAFT',
        customerId: 'cust-1',
        shippingAddressId: 'addr-1',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sale.assignCustomer('cust-2');

      expect(sale.customerId).toBe('cust-2');
      expect(sale.shippingAddressId).toBeNull();
    });

    it('throws when assigning customer on non-DRAFT sale', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(() => sale.assignCustomer('cust-1')).toThrow(
        new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT'),
      );
    });
  });

  describe('clearCustomer', () => {
    it('clears both customer and shipping address on DRAFT sale', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'DRAFT',
        customerId: 'cust-1',
        shippingAddressId: 'addr-1',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sale.clearCustomer();

      expect(sale.customerId).toBeNull();
      expect(sale.shippingAddressId).toBeNull();
    });

    it('is idempotent when customer is already null', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.clearCustomer();
      sale.clearCustomer();

      expect(sale.customerId).toBeNull();
      expect(sale.shippingAddressId).toBeNull();
    });

    it('throws when clearing customer on non-DRAFT sale', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        customerId: 'cust-1',
        shippingAddressId: 'addr-1',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(() => sale.clearCustomer()).toThrow(
        new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT'),
      );
    });
  });

  describe('setShippingAddress', () => {
    it('sets shipping address when sale has customer and is DRAFT', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'DRAFT',
        customerId: 'cust-1',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sale.setShippingAddress('addr-1');

      expect(sale.shippingAddressId).toBe('addr-1');
    });

    it('throws when setting non-null shipping address without customer', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      expect(() => sale.setShippingAddress('addr-1')).toThrow(
        new BusinessRuleViolationError(
          'SHIPPING_ADDRESS_REQUIRES_CUSTOMER',
          'SHIPPING_ADDRESS_REQUIRES_CUSTOMER',
        ),
      );
    });

    it('throws when setting shipping address on non-DRAFT sale', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        customerId: 'cust-1',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(() => sale.setShippingAddress('addr-1')).toThrow(
        new BusinessRuleViolationError('SALE_NOT_DRAFT', 'SALE_NOT_DRAFT'),
      );
    });

    it('clears shipping address when setting null', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'DRAFT',
        customerId: 'cust-1',
        shippingAddressId: 'addr-1',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sale.setShippingAddress(null);

      expect(sale.shippingAddressId).toBeNull();
    });
  });

  describe('addItem - add new item to sale', () => {
    it('should add new item when product not yet in sale', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(sale.items).toHaveLength(1);
      expect(sale.items[0].productId).toBe('prod-001');
      expect(sale.items[0].quantity).toBe(2);
      expect(sale.items[0].unitPriceCents).toBe(5000);
    });

    it('should stack quantity when adding same product+variant combination', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440011',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 3,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(sale.items).toHaveLength(1);
      expect(sale.items[0].quantity).toBe(5);
    });

    it('should create separate items for same product but different variants', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: 'var-red',
        productName: 'Test Product',
        variantName: 'Red',
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440011',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: 'var-blue',
        productName: 'Test Product',
        variantName: 'Blue',
        quantity: 3,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(sale.items).toHaveLength(2);
      expect(sale.items[0].variantId).toBe('var-red');
      expect(sale.items[0].quantity).toBe(2);
      expect(sale.items[1].variantId).toBe('var-blue');
      expect(sale.items[1].quantity).toBe(3);
    });

    it('should throw if quantity is less than 1', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      expect(() =>
        sale.addItem({
          id: '550e8400-e29b-41d4-a716-446655440010',
          saleId: BASE_SALE_ID,
          productId: 'prod-001',
          variantId: null,
          productName: 'Test Product',
          variantName: null,
          quantity: 0,
          unitPriceCents: 5000,
          unitPriceCurrency: 'MXN',
        }),
      ).toThrow(InvalidArgumentError);
    });
  });

  describe('updateItemQuantity - change quantity of existing item', () => {
    it('should update quantity of existing item', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      const itemId = '550e8400-e29b-41d4-a716-446655440010';
      sale.addItem({
        id: itemId,
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      sale.updateItemQuantity(itemId, 5);

      expect(sale.items[0].quantity).toBe(5);
    });

    it('should throw BusinessRuleViolationError if item not found', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      expect(() => sale.updateItemQuantity('nonexistent-id', 5)).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('should throw InvalidArgumentError if new quantity is less than 1', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      const itemId = '550e8400-e29b-41d4-a716-446655440010';
      sale.addItem({
        id: itemId,
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      expect(() => sale.updateItemQuantity(itemId, 0)).toThrow(
        InvalidArgumentError,
      );
    });

    it('should keep discount metadata unchanged when quantity changes', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      const itemId = '550e8400-e29b-41d4-a716-446655440012';
      sale.addItem({
        id: itemId,
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      sale.applyItemDiscount(itemId, {
        type: 'percentage',
        percent: 10,
        discountTitle: 'Promo',
      });

      const discountBeforeUpdate = {
        discountType: sale.items[0].discountType,
        discountValue: sale.items[0].discountValue,
        discountAmountCents: sale.items[0].discountAmountCents,
        prePriceCentsBeforeDiscount: sale.items[0].prePriceCentsBeforeDiscount,
        discountTitle: sale.items[0].discountTitle,
        discountedAt: sale.items[0].discountedAt,
      };

      sale.updateItemQuantity(itemId, 5);

      expect(sale.items[0].quantity).toBe(5);
      expect(sale.items[0].discountType).toBe(
        discountBeforeUpdate.discountType,
      );
      expect(sale.items[0].discountValue).toBe(
        discountBeforeUpdate.discountValue,
      );
      expect(sale.items[0].discountAmountCents).toBe(
        discountBeforeUpdate.discountAmountCents,
      );
      expect(sale.items[0].prePriceCentsBeforeDiscount).toBe(
        discountBeforeUpdate.prePriceCentsBeforeDiscount,
      );
      expect(sale.items[0].discountTitle).toBe(
        discountBeforeUpdate.discountTitle,
      );
      expect(sale.items[0].discountedAt).toBe(
        discountBeforeUpdate.discountedAt,
      );
    });
  });

  describe('clearItems - remove all items from sale', () => {
    it('should remove all items from sale', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Product 1',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440011',
        saleId: BASE_SALE_ID,
        productId: 'prod-002',
        variantId: null,
        productName: 'Product 2',
        variantName: null,
        quantity: 1,
        unitPriceCents: 3000,
        unitPriceCurrency: 'MXN',
      });

      expect(sale.items).toHaveLength(2);

      sale.clearItems();

      expect(sale.items).toHaveLength(0);
    });

    it('should be idempotent when sale already empty', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.clearItems();
      expect(sale.items).toHaveLength(0);

      sale.clearItems();
      expect(sale.items).toHaveLength(0);
    });
  });

  describe('removeItem - remove one item from sale', () => {
    it('should remove only the selected item and preserve others', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      const itemToKeepId = '550e8400-e29b-41d4-a716-446655440020';
      const itemToRemoveId = '550e8400-e29b-41d4-a716-446655440021';

      sale.addItem({
        id: itemToKeepId,
        saleId: BASE_SALE_ID,
        productId: 'prod-keep',
        variantId: null,
        productName: 'Keep product',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.addItem({
        id: itemToRemoveId,
        saleId: BASE_SALE_ID,
        productId: 'prod-remove',
        variantId: null,
        productName: 'Remove product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 2000,
        unitPriceCurrency: 'MXN',
      });

      sale.removeItem(itemToRemoveId);

      expect(sale.items).toHaveLength(1);
      expect(sale.items[0].id).toBe(itemToKeepId);
      expect(sale.items[0].productId).toBe('prod-keep');
    });

    it('should throw SALE_ITEM_NOT_FOUND when item does not belong to sale', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440022',
        saleId: BASE_SALE_ID,
        productId: 'prod-only',
        variantId: null,
        productName: 'Only product',
        variantName: null,
        quantity: 1,
        unitPriceCents: 3000,
        unitPriceCurrency: 'MXN',
      });

      expect(() =>
        sale.removeItem('550e8400-e29b-41d4-a716-446655449999'),
      ).toThrow(
        new BusinessRuleViolationError(
          'SALE_ITEM_NOT_FOUND',
          'SALE_ITEM_NOT_FOUND',
        ),
      );
    });
  });

  describe('toResponse - convert to API response', () => {
    it('should return response with all sale fields', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      const response = sale.toResponse();

      expect(response.id).toBe(BASE_SALE_ID);
      expect(response.userId).toBe(USER_ID);
      expect(response.status).toBe('DRAFT');
      expect(response.items).toHaveLength(1);
      expect(response.items[0].productId).toBe('prod-001');
      expect(response.items[0].quantity).toBe(2);
    });

    // -----------------------------------------------------------------
    // Work Unit: surface preview totals on DRAFT toResponse so the POS
    // renders Subtotal/Total correctly. The persisted `totalCents` is 0
    // for drafts (only written at CHARGE time); the response must instead
    // derive live totals from `previewTotals()` so the POS sees the
    // order-discount-aware and per-line-discount-aware figures.
    // -----------------------------------------------------------------
    it('should surface previewTotals-derived subtotalCents/discountCents/totalCents for a DRAFT with no items (empty draft)', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      const response = sale.toResponse();

      expect(response.status).toBe('DRAFT');
      expect(response.subtotalCents).toBe(0);
      expect(response.discountCents).toBe(0);
      expect(response.totalCents).toBe(0);
    });

    it('should surface previewTotals-derived totals for a DRAFT with no discounts (single item, qty 1)', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 1,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      const response = sale.toResponse();

      expect(response.status).toBe('DRAFT');
      // base = unitPriceCents (no per-line discount to roll back)
      expect(response.subtotalCents).toBe(5000);
      expect(response.discountCents).toBe(0);
      expect(response.totalCents).toBe(5000);
    });

    it('should surface previewTotals-derived totals for a DRAFT with a per-line discount (the POS $0.00 bug case: $100 base -> $80 charged)', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 1,
        unitPriceCents: 10000,
        unitPriceCurrency: 'MXN',
      });
      // 20% off -> discount = 2000, unit price becomes 8000, prePrice rolled back to 10000
      sale.applyItemDiscount('550e8400-e29b-41d4-a716-446655440010', {
        type: 'percentage',
        percent: 20,
        discountTitle: '20% off',
      });

      const response = sale.toResponse();

      expect(response.status).toBe('DRAFT');
      // subtotalCents uses prePriceCentsBeforeDiscount (10000) as base
      expect(response.subtotalCents).toBe(10000);
      // discountCents = full savings (per-line + order)
      expect(response.discountCents).toBe(2000);
      // totalCents = what the customer will actually pay (post-line)
      expect(response.totalCents).toBe(8000);
    });

    it('should surface previewTotals-derived totals for a DRAFT with an order-level promotion', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: '550e8400-e29b-41d4-a716-446655440010',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 1,
        unitPriceCents: 2000,
        unitPriceCurrency: 'MXN',
      });
      sale.setAppliedOrderPromotion({
        promotionId: 'promo-order',
        discountType: 'amount',
        discountValue: 500,
        discountAmountCents: 500,
        discountTitle: '$500 off',
      });

      const response = sale.toResponse();

      expect(response.status).toBe('DRAFT');
      expect(response.subtotalCents).toBe(2000);
      expect(response.discountCents).toBe(500);
      expect(response.totalCents).toBe(1500);
    });

    it('should NOT add previewTotals-derived subtotalCents/discountCents keys for a CONFIRMED sale (byte-for-byte shape preserved)', () => {
      // The persisted `totalCents` is the source of truth on confirmed sales —
      // previewTotals() is a draft-time projection and must NOT be surfaced on
      // a confirmed response (would regress receipts/list mappers that read
      // the charged totalCents). The DRAFT guard inside toResponse() is what
      // enforces this.
      const confirmedAt = new Date('2026-05-06T12:00:00.000Z');
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        items: [
          {
            id: '550e8400-e29b-41d4-a716-446655440010',
            saleId: BASE_SALE_ID,
            productId: 'prod-001',
            variantId: null,
            productName: 'Test Product',
            variantName: null,
            quantity: 1,
            unitPriceCents: 10000,
            unitPriceCurrency: 'MXN',
          },
        ],
        confirmedAt,
        folio: 'A-2605-000001',
        totalCents: 10000,
        paidCents: 10000,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = sale.toResponse();

      // The persisted total must be surfaced (not previewTotals-derived).
      expect(response.status).toBe('CONFIRMED');
      expect(response.totalCents).toBe(10000);

      // The pre-fix shape had no subtotalCents / discountCents keys for
      // CONFIRMED sales — assert they are STILL absent (byte-for-byte
      // shape unchanged for confirmed) so receipts/list mappers don't
      // accidentally start reading preview values.
      expect(
        Object.prototype.hasOwnProperty.call(response, 'subtotalCents'),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(response, 'discountCents'),
      ).toBe(false);
    });
  });

  describe('overrideItemPrice', () => {
    it('should delegate override to selected item', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      const itemId = '550e8400-e29b-41d4-a716-446655440010';
      sale.addItem({
        id: itemId,
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 2,
        unitPriceCents: 5000,
        unitPriceCurrency: 'MXN',
      });

      sale.overrideItemPrice(itemId, {
        priceCents: 4500,
        priceSource: 'price_list',
        appliedPriceListId: 'list-1',
        customPriceCents: null,
      });

      expect(sale.items[0].unitPriceCents).toBe(4500);
      expect(sale.items[0].priceSource).toBe('price_list');
    });

    it('should throw SALE_ITEM_NOT_FOUND when item is missing', () => {
      const sale = Sale.create({
        id: BASE_SALE_ID,
        userId: USER_ID,
      });

      expect(() =>
        sale.overrideItemPrice('missing-item', {
          priceCents: 4500,
          priceSource: 'price_list',
          appliedPriceListId: 'list-1',
          customPriceCents: null,
        }),
      ).toThrow(BusinessRuleViolationError);
      expect(() =>
        sale.overrideItemPrice('missing-item', {
          priceCents: 4500,
          priceSource: 'price_list',
          appliedPriceListId: 'list-1',
          customPriceCents: null,
        }),
      ).toThrow(/SALE_ITEM_NOT_FOUND/);
    });
  });

  describe('item discounts', () => {
    it('applies discount to selected item', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: 'item-discount',
        saleId: BASE_SALE_ID,
        productId: 'prod-001',
        variantId: null,
        productName: 'Test Product',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      sale.applyItemDiscount('item-discount', {
        type: 'amount',
        amountCents: 100,
      });
      expect(sale.items[0].discountType).toBe('amount');
      expect(sale.items[0].unitPriceCents).toBe(900);
    });

    it('throws SALE_ITEM_NOT_FOUND for missing item', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      expect(() =>
        sale.applyItemDiscount('missing', { type: 'amount', amountCents: 100 }),
      ).toThrow(BusinessRuleViolationError);
    });
  });

  describe('global discounts', () => {
    it('applies percentage discount to all items and returns empty skippedItems', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: 'item-global-1',
        saleId: BASE_SALE_ID,
        productId: 'prod-1',
        variantId: null,
        productName: 'P1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.addItem({
        id: 'item-global-2',
        saleId: BASE_SALE_ID,
        productId: 'prod-2',
        variantId: null,
        productName: 'P2',
        variantName: null,
        quantity: 1,
        unitPriceCents: 2000,
        unitPriceCurrency: 'MXN',
      });

      const result = sale.applyGlobalDiscount({
        type: 'percentage',
        percent: 10,
      });

      expect(result.sale).toBe(sale);
      expect(result.skippedItems).toEqual([]);
      expect(result.sale.items[0].unitPriceCents).toBe(900);
      expect(result.sale.items[1].unitPriceCents).toBe(1800);
    });

    it('skips amount underflow items and keeps them unchanged', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: 'item-global-ok',
        saleId: BASE_SALE_ID,
        productId: 'prod-ok',
        variantId: null,
        productName: 'P1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.addItem({
        id: 'item-global-skip',
        saleId: BASE_SALE_ID,
        productId: 'prod-skip',
        variantId: null,
        productName: 'P2',
        variantName: null,
        quantity: 1,
        unitPriceCents: 300,
        unitPriceCurrency: 'MXN',
      });

      const result = sale.applyGlobalDiscount({
        type: 'amount',
        amountCents: 500,
      });

      expect(result.skippedItems).toEqual([
        { itemId: 'item-global-skip', reason: 'DISCOUNT_AMOUNT_INVALID' },
      ]);
      expect(result.sale.items[0].unitPriceCents).toBe(500);
      expect(result.sale.items[1].unitPriceCents).toBe(300);
      expect(result.sale.items[1].discountType).toBeNull();
    });

    it('replaces existing item discounts using baseline price', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: 'item-global-replace',
        saleId: BASE_SALE_ID,
        productId: 'prod-replace',
        variantId: null,
        productName: 'P3',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      sale.applyItemDiscount('item-global-replace', {
        type: 'percentage',
        percent: 10,
      });

      const result = sale.applyGlobalDiscount({
        type: 'percentage',
        percent: 20,
      });

      expect(result.skippedItems).toEqual([]);
      expect(result.sale.items[0].prePriceCentsBeforeDiscount).toBe(1000);
      expect(result.sale.items[0].unitPriceCents).toBe(800);
      expect(result.sale.items[0].discountValue).toBe(20);
    });

    it('skips already-discounted items when strategy is skip', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: 'item-already-discounted',
        saleId: BASE_SALE_ID,
        productId: 'prod-1',
        variantId: null,
        productName: 'P1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.addItem({
        id: 'item-no-discount',
        saleId: BASE_SALE_ID,
        productId: 'prod-2',
        variantId: null,
        productName: 'P2',
        variantName: null,
        quantity: 1,
        unitPriceCents: 2000,
        unitPriceCurrency: 'MXN',
      });

      // Apply individual discount to first item
      sale.applyItemDiscount('item-already-discounted', {
        type: 'percentage',
        percent: 10,
      });

      // Apply global with skip strategy
      const result = sale.applyGlobalDiscount({
        type: 'percentage',
        percent: 20,
        strategy: 'skip',
      });

      // First item should keep its original 10% discount
      expect(result.sale.items[0].discountValue).toBe(10);
      expect(result.sale.items[0].unitPriceCents).toBe(900);
      // First item should appear in skippedItems with ALREADY_DISCOUNTED reason
      expect(result.skippedItems).toEqual(
        expect.arrayContaining([
          { itemId: 'item-already-discounted', reason: 'ALREADY_DISCOUNTED' },
        ]),
      );

      // Second item should get the global 20% discount
      expect(result.sale.items[1].discountValue).toBe(20);
      expect(result.sale.items[1].unitPriceCents).toBe(1600);
    });

    it('replaces all discounts when strategy is replace (default)', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: 'item-has-discount',
        saleId: BASE_SALE_ID,
        productId: 'prod-1',
        variantId: null,
        productName: 'P1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      sale.applyItemDiscount('item-has-discount', {
        type: 'percentage',
        percent: 10,
      });

      // Default strategy (no strategy field) = replace
      const result = sale.applyGlobalDiscount({
        type: 'percentage',
        percent: 20,
      });

      // Should be replaced with 20%
      expect(result.sale.items[0].discountValue).toBe(20);
      expect(result.sale.items[0].unitPriceCents).toBe(800);
      expect(result.skippedItems).toEqual([]);
    });

    it('replaces all discounts when strategy is explicitly replace', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: 'item-explicit-replace',
        saleId: BASE_SALE_ID,
        productId: 'prod-1',
        variantId: null,
        productName: 'P1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      sale.applyItemDiscount('item-explicit-replace', {
        type: 'amount',
        amountCents: 100,
      });

      const result = sale.applyGlobalDiscount({
        type: 'percentage',
        percent: 15,
        strategy: 'replace',
      });

      expect(result.sale.items[0].discountValue).toBe(15);
      expect(result.sale.items[0].unitPriceCents).toBe(850);
      expect(result.skippedItems).toEqual([]);
    });

    it('applies to all items when strategy is skip but no items have discounts', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: 'item-skip-clean-1',
        saleId: BASE_SALE_ID,
        productId: 'prod-1',
        variantId: null,
        productName: 'P1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.addItem({
        id: 'item-skip-clean-2',
        saleId: BASE_SALE_ID,
        productId: 'prod-2',
        variantId: null,
        productName: 'P2',
        variantName: null,
        quantity: 1,
        unitPriceCents: 2000,
        unitPriceCurrency: 'MXN',
      });

      const result = sale.applyGlobalDiscount({
        type: 'percentage',
        percent: 10,
        strategy: 'skip',
      });

      expect(result.skippedItems).toEqual([]);
      expect(result.sale.items[0].unitPriceCents).toBe(900);
      expect(result.sale.items[1].unitPriceCents).toBe(1800);
    });

    it('succeeds on empty sales with no skipped items', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });

      const result = sale.applyGlobalDiscount({
        type: 'percentage',
        percent: 10,
      });

      expect(result.sale).toBe(sale);
      expect(result.skippedItems).toEqual([]);
      expect(result.sale.items).toEqual([]);
    });

    it('removes discounts from all items and is idempotent', () => {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: 'item-remove-1',
        saleId: BASE_SALE_ID,
        productId: 'prod-1',
        variantId: null,
        productName: 'P1',
        variantName: null,
        quantity: 1,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });
      sale.addItem({
        id: 'item-remove-2',
        saleId: BASE_SALE_ID,
        productId: 'prod-2',
        variantId: null,
        productName: 'P2',
        variantName: null,
        quantity: 1,
        unitPriceCents: 800,
        unitPriceCurrency: 'MXN',
      });
      sale.applyGlobalDiscount({ type: 'amount', amountCents: 100 });

      const result = sale.removeGlobalDiscount();
      expect(result).toBe(sale);
      expect(result.items[0].discountType).toBeNull();
      expect(result.items[1].discountType).toBeNull();
      expect(result.items[0].unitPriceCents).toBe(1000);
      expect(result.items[1].unitPriceCents).toBe(800);

      expect(() => sale.removeGlobalDiscount()).not.toThrow();
    });
  });

  // ── Delivery Metadata (Slice 6: bot sales) ──────────────────────────────────

  describe('setDeliveryMetadata - update carrier/tracking/ETA', () => {
    it('sets carrier name, tracking ref, and estimated delivery date', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const eta = new Date('2026-06-20T00:00:00.000Z');
      sale.setDeliveryMetadata({
        carrierName: 'DHL',
        trackingRef: 'DHL-1234567890',
        estimatedDeliveryAt: eta,
      });

      expect(sale.carrierName).toBe('DHL');
      expect(sale.trackingRef).toBe('DHL-1234567890');
      expect(sale.estimatedDeliveryAt).toBe(eta);
    });

    it('allows clearing delivery metadata by setting null values', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        carrierName: 'DHL',
        trackingRef: 'DHL-1234567890',
        estimatedDeliveryAt: new Date('2026-06-20T00:00:00.000Z'),
      });

      sale.setDeliveryMetadata({
        carrierName: null,
        trackingRef: null,
        estimatedDeliveryAt: null,
      });

      expect(sale.carrierName).toBeNull();
      expect(sale.trackingRef).toBeNull();
      expect(sale.estimatedDeliveryAt).toBeNull();
    });
  });

  describe('fromPersistence - delivery metadata reconstitution', () => {
    it('reconstitutes delivery metadata fields from persistence', () => {
      const eta = new Date('2026-06-20T00:00:00.000Z');
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        carrierName: 'Estafeta',
        trackingRef: 'EST-9876',
        estimatedDeliveryAt: eta,
      });

      expect(sale.carrierName).toBe('Estafeta');
      expect(sale.trackingRef).toBe('EST-9876');
      expect(sale.estimatedDeliveryAt).toBe(eta);
    });

    it('defaults delivery metadata to null when not provided', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'CONFIRMED',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(sale.carrierName).toBeNull();
      expect(sale.trackingRef).toBeNull();
      expect(sale.estimatedDeliveryAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Work Unit 3 — Task 3.3: Sale-level promotion state + previewTotals (C2)
  //
  // `appliedOrderPromotion` (when set) contributes an order-level discount to
  // the sale total via `previewTotals()`. `vetoedPromotionIds` and
  // `optedInManualPromotionIds` expose the per-draft promotion state stored in
  // `sale_promotion_vetoes` and `sale_applied_promotions` (manual opt-in is
  // captured elsewhere in Unit 6 — Unit 3 only models the in-memory shape).
  // ---------------------------------------------------------------------------
  describe('appliedOrderPromotion + previewTotals + veto/opt-in (C2, Unit 3)', () => {
    function makeSaleWithItem(unitPriceCents: number, quantity: number): Sale {
      const sale = Sale.create({ id: BASE_SALE_ID, userId: USER_ID });
      sale.addItem({
        id: 'item-prev',
        saleId: BASE_SALE_ID,
        productId: 'prod-prev',
        variantId: null,
        productName: 'P',
        variantName: null,
        quantity,
        unitPriceCents,
        unitPriceCurrency: 'MXN',
      });
      return sale;
    }

    it('starts with no applied order promotion and empty sets', () => {
      const sale = makeSaleWithItem(1000, 2);
      expect(sale.appliedOrderPromotion).toBeNull();
      expect(sale.vetoedPromotionIds).toEqual([]);
      expect(sale.optedInManualPromotionIds).toEqual([]);
    });

    it('previewTotals returns subtotal = Σ(unitPrice*qty) when no order promotion', () => {
      const sale = makeSaleWithItem(1000, 2);
      const totals = sale.previewTotals();
      expect(totals.subtotalCents).toBe(2000);
      expect(totals.discountCents).toBe(0);
      expect(totals.totalCents).toBe(2000);
    });

    it('previewTotals subtracts the order discount from the per-line subtotal (C2)', () => {
      const sale = makeSaleWithItem(1000, 3);
      sale.setAppliedOrderPromotion({
        promotionId: 'promo-order',
        discountType: 'amount',
        discountValue: 500,
        discountAmountCents: 500,
        discountTitle: '$500 off',
      });
      const totals = sale.previewTotals();
      expect(totals.subtotalCents).toBe(3000);
      expect(totals.discountCents).toBe(500);
      expect(totals.totalCents).toBe(2500);
    });

    it('previewTotals clamps totalCents to 0 (never negative) when order discount exceeds subtotal', () => {
      const sale = makeSaleWithItem(100, 1);
      sale.setAppliedOrderPromotion({
        promotionId: 'promo-overkill',
        discountType: 'amount',
        discountValue: 500,
        discountAmountCents: 500,
        discountTitle: 'overkill',
      });
      const totals = sale.previewTotals();
      expect(totals.subtotalCents).toBe(100);
      expect(totals.discountCents).toBe(100);
      expect(totals.totalCents).toBe(0);
    });

    it('clearAppliedOrderPromotion restores the no-discount math', () => {
      const sale = makeSaleWithItem(1000, 2);
      sale.setAppliedOrderPromotion({
        promotionId: 'promo-order',
        discountType: 'amount',
        discountValue: 200,
        discountAmountCents: 200,
        discountTitle: '$200 off',
      });
      sale.clearAppliedOrderPromotion();
      const totals = sale.previewTotals();
      expect(totals.subtotalCents).toBe(2000);
      expect(totals.discountCents).toBe(0);
      expect(totals.totalCents).toBe(2000);
      expect(sale.appliedOrderPromotion).toBeNull();
    });

    it('tracks vetoedPromotionIds via addVetoedPromotion / removeVetoedPromotion', () => {
      const sale = makeSaleWithItem(1000, 1);
      sale.addVetoedPromotion('promo-a');
      sale.addVetoedPromotion('promo-b');
      expect(sale.vetoedPromotionIds).toEqual(['promo-a', 'promo-b']);
      sale.removeVetoedPromotion('promo-a');
      expect(sale.vetoedPromotionIds).toEqual(['promo-b']);
    });

    it('tracks optedInManualPromotionIds via optInManualPromotion / optOutManualPromotion', () => {
      const sale = makeSaleWithItem(1000, 1);
      sale.optInManualPromotion('promo-m');
      sale.optInManualPromotion('promo-n');
      expect(sale.optedInManualPromotionIds).toEqual(['promo-m', 'promo-n']);
      sale.optOutManualPromotion('promo-m');
      expect(sale.optedInManualPromotionIds).toEqual(['promo-n']);
    });

    // -------------------------------------------------------------------------
    // Work Unit — optInManualPromotion / addVetoedPromotion mutual exclusion
    //
    // Invariant: for every draft, optedInManualPromotionIds ∩
    // vetoedPromotionIds = ∅. The entity owns this invariant — the
    // cross-clearing behavior means a draft can NEVER reach the
    // (opted-in, vetoed) corrupt state. Legacy corrupt drafts are
    // tolerated at the engine layer (see engine spec) but never produced
    // by new entity mutations.
    // -------------------------------------------------------------------------
    describe('optIn / veto mutual exclusion', () => {
      function setsDisjoint(
        sale: Sale,
        optedId: string,
        vetoedId: string,
      ): void {
        if (optedId === vetoedId) return; // same id, the disjointness is checked separately
        const optedSet = new Set(sale.optedInManualPromotionIds);
        const vetoedSet = new Set(sale.vetoedPromotionIds);
        expect(optedSet.has(vetoedId)).toBe(false);
        expect(vetoedSet.has(optedId)).toBe(false);
      }

      it('optInManualPromotion removes the id from the veto set when it was vetoed (cross-clear)', () => {
        const sale = makeSaleWithItem(1000, 1);
        sale.addVetoedPromotion('promo-m-1');
        expect(sale.vetoedPromotionIds).toEqual(['promo-m-1']);
        expect(sale.optedInManualPromotionIds).toEqual([]);

        sale.optInManualPromotion('promo-m-1');

        // The same id MUST NOT be in both sets after optIn.
        expect(sale.optedInManualPromotionIds).toContain('promo-m-1');
        expect(sale.vetoedPromotionIds).not.toContain('promo-m-1');
      });

      it('addVetoedPromotion removes the id from the opted-in set when it was opted-in (cross-clear)', () => {
        const sale = makeSaleWithItem(1000, 1);
        sale.optInManualPromotion('promo-m-1');
        expect(sale.optedInManualPromotionIds).toContain('promo-m-1');
        expect(sale.vetoedPromotionIds).toEqual([]);

        sale.addVetoedPromotion('promo-m-1');

        // The same id MUST NOT be in both sets after veto.
        expect(sale.vetoedPromotionIds).toContain('promo-m-1');
        expect(sale.optedInManualPromotionIds).not.toContain('promo-m-1');
      });

      it('optInManualPromotion is idempotent when id already opted-in (no spurious veto removal)', () => {
        const sale = makeSaleWithItem(1000, 1);
        sale.addVetoedPromotion('promo-keep-vetoed');
        sale.optInManualPromotion('promo-m-1');

        // Re-opt-in: must not affect unrelated vetoed entries.
        sale.optInManualPromotion('promo-m-1');

        expect(sale.optedInManualPromotionIds).toEqual(['promo-m-1']);
        expect(sale.vetoedPromotionIds).toEqual(['promo-keep-vetoed']);
      });

      it('addVetoedPromotion is idempotent when id already vetoed (no spurious opt-in removal)', () => {
        const sale = makeSaleWithItem(1000, 1);
        sale.optInManualPromotion('promo-keep-opted');
        sale.addVetoedPromotion('promo-auto-1');

        // Re-veto: must not affect unrelated opted-in entries.
        sale.addVetoedPromotion('promo-auto-1');

        expect(sale.vetoedPromotionIds).toEqual(['promo-auto-1']);
        expect(sale.optedInManualPromotionIds).toEqual(['promo-keep-opted']);
      });

      it('optOutManualPromotion remains a simple removal (cannot create corruption)', () => {
        const sale = makeSaleWithItem(1000, 1);
        sale.optInManualPromotion('promo-m-1');
        sale.optOutManualPromotion('promo-m-1');
        expect(sale.optedInManualPromotionIds).not.toContain('promo-m-1');
        expect(sale.vetoedPromotionIds).not.toContain('promo-m-1');
      });

      it('removeVetoedPromotion remains a simple removal (cannot create corruption)', () => {
        const sale = makeSaleWithItem(1000, 1);
        sale.addVetoedPromotion('promo-auto-1');
        sale.removeVetoedPromotion('promo-auto-1');
        expect(sale.vetoedPromotionIds).not.toContain('promo-auto-1');
        expect(sale.optedInManualPromotionIds).not.toContain('promo-auto-1');
      });

      it('property: any sequence of mutators keeps optedIn ∩ vetoed = ∅', () => {
        const sale = makeSaleWithItem(1000, 1);
        // Random-ish but deterministic sequence of cross-mutators that
        // would, WITHOUT the cross-clear, leave some id in both sets.
        sale.optInManualPromotion('promo-x');
        sale.addVetoedPromotion('promo-x');
        sale.optInManualPromotion('promo-y');
        sale.addVetoedPromotion('promo-y');
        sale.optInManualPromotion('promo-z');
        sale.removeVetoedPromotion('promo-x');
        sale.addVetoedPromotion('promo-z');
        sale.optOutManualPromotion('promo-y');
        sale.optInManualPromotion('promo-x');

        // Whatever the final state, no id may live in BOTH sets.
        const opted = new Set(sale.optedInManualPromotionIds);
        for (const vetoedId of sale.vetoedPromotionIds) {
          expect(opted.has(vetoedId)).toBe(false);
        }
        const vetoed = new Set(sale.vetoedPromotionIds);
        for (const optedId of sale.optedInManualPromotionIds) {
          expect(vetoed.has(optedId)).toBe(false);
        }
        // spot-check the two sets have distinct ids (sanity)
        setsDisjoint(sale, 'promo-x', 'promo-y');
      });
    });

    it('fromPersistence maps appliedOrderPromotion + vetoedPromotionIds + optedInManualPromotionIds', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'DRAFT',
        items: [
          {
            id: 'item-p',
            saleId: BASE_SALE_ID,
            productId: 'p',
            variantId: null,
            productName: 'P',
            variantName: null,
            quantity: 2,
            unitPriceCents: 1500,
            unitPriceCurrency: 'MXN',
            promotionId: 'promo-item',
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
        appliedOrderPromotion: {
          promotionId: 'promo-order',
          discountType: 'amount',
          discountValue: 300,
          discountAmountCents: 300,
          discountTitle: '$300 off',
        },
        vetoedPromotionIds: ['promo-v1', 'promo-v2'],
        optedInManualPromotionIds: ['promo-m'],
      });

      expect(sale.appliedOrderPromotion).toEqual({
        promotionId: 'promo-order',
        discountType: 'amount',
        discountValue: 300,
        discountAmountCents: 300,
        discountTitle: '$300 off',
      });
      expect(sale.vetoedPromotionIds).toEqual(['promo-v1', 'promo-v2']);
      expect(sale.optedInManualPromotionIds).toEqual(['promo-m']);
      expect(sale.items[0].promotionId).toBe('promo-item');

      const totals = sale.previewTotals();
      expect(totals.subtotalCents).toBe(3000);
      expect(totals.discountCents).toBe(300);
      expect(totals.totalCents).toBe(2700);
    });

    it('fromPersistence defaults to null appliedOrderPromotion and empty sets when omitted', () => {
      const sale = Sale.fromPersistence({
        id: BASE_SALE_ID,
        userId: USER_ID,
        status: 'DRAFT',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(sale.appliedOrderPromotion).toBeNull();
      expect(sale.vetoedPromotionIds).toEqual([]);
      expect(sale.optedInManualPromotionIds).toEqual([]);
    });
  });
});
