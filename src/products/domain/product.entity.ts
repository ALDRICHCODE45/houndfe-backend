/**
 * ENTITY: Product (Aggregate Root)
 *
 * Pure domain logic. No framework dependencies.
 *
 * BUSINESS RULES:
 * - name required
 * - type defaults to PRODUCT
 * - sku/barcode optional but globally unique (enforced at app layer)
 * - sellInPos, includeInOnlineCatalog, useStock, chargeProductTaxes default true
 * - when hasVariants=true, inventory section only exposes useStock
 * - brand optional (same pattern as category)
 * - quantity/minQuantity only relevant when no variants and useStock
 */
import { ProductName } from './value-objects/productName.value-object';
import { IvaRate, IvaRateValue } from './value-objects/iva-rate.value-object';
import {
  IepsRate,
  IepsRateValue,
} from './value-objects/ieps-rate.value-object';
import {
  PurchaseCost,
  PurchaseCostModeValue,
} from './value-objects/purchase-cost.value-object';
import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';

export type ProductType = 'PRODUCT' | 'SERVICE';
export type UnitOfMeasure =
  | 'UNIDAD'
  | 'CAJA'
  | 'BOLSA'
  | 'METRO'
  | 'CENTIMETRO'
  | 'KILOGRAMO'
  | 'GRAMO'
  | 'LITRO'
  | 'HORA'
  | 'SESION'
  | 'DIA'
  | 'CONSULTA'
  | 'CURSO'
  | 'PAQUETE';

export interface ProductServiceDetail {
  id: string;
  productId: string;
  capacity: number | null;
  notes: string | null;
}

export const VALID_UNITS: UnitOfMeasure[] = [
  'UNIDAD',
  'CAJA',
  'BOLSA',
  'METRO',
  'CENTIMETRO',
  'KILOGRAMO',
  'GRAMO',
  'LITRO',
  'HORA',
  'SESION',
  'DIA',
  'CONSULTA',
  'CURSO',
  'PAQUETE',
];

export const SERVICE_FORCED_DEFAULTS = {
  type: 'SERVICE',
  sku: null,
  barcode: null,
  brandId: null,
  purchaseCostMode: 'NET',
  purchaseNetCostCents: 0,
  purchaseGrossCostCents: 0,
  useStock: false,
  useLotsAndExpirations: false,
  quantity: 0,
  minQuantity: 0,
} as const;

export interface ProductProps {
  id: string;
  name: ProductName;
  location: string | null;
  description: string | null;
  type: ProductType;
  sku: string | null;
  barcode: string | null;
  unit: UnitOfMeasure;
  satKey: string | null;
  categoryId: string | null;
  brandId: string | null;
  sellInPos: boolean;
  includeInOnlineCatalog: boolean;
  requiresPrescription: boolean;
  chargeProductTaxes: boolean;
  ivaRate: IvaRate;
  iepsRate: IepsRate;
  purchaseCost: PurchaseCost;
  useStock: boolean;
  useLotsAndExpirations: boolean;
  quantity: number;
  minQuantity: number;
  hasVariants: boolean;
  serviceDetail: ProductServiceDetail | null;
  createdAt: Date;
  updatedAt: Date;
}

export class Product {
  public readonly id: string;
  public name: ProductName;
  public location: string | null;
  public description: string | null;
  public type: ProductType;
  public sku: string | null;
  public barcode: string | null;
  public unit: UnitOfMeasure;
  public satKey: string | null;
  public categoryId: string | null;
  public brandId: string | null;
  public sellInPos: boolean;
  public includeInOnlineCatalog: boolean;
  public requiresPrescription: boolean;
  public chargeProductTaxes: boolean;
  public ivaRate: IvaRate;
  public iepsRate: IepsRate;
  public purchaseCost: PurchaseCost;
  public useStock: boolean;
  public useLotsAndExpirations: boolean;
  public quantity: number;
  public minQuantity: number;
  public hasVariants: boolean;
  public serviceDetail: ProductServiceDetail | null;
  public readonly createdAt: Date;
  public updatedAt: Date;

  private constructor(props: ProductProps) {
    this.id = props.id;
    this.name = props.name;
    this.location = props.location;
    this.description = props.description;
    this.type = props.type;
    this.sku = props.sku;
    this.barcode = props.barcode;
    this.unit = props.unit;
    this.satKey = props.satKey;
    this.categoryId = props.categoryId;
    this.brandId = props.brandId;
    this.sellInPos = props.sellInPos;
    this.includeInOnlineCatalog = props.includeInOnlineCatalog;
    this.requiresPrescription = props.requiresPrescription;
    this.chargeProductTaxes = props.chargeProductTaxes;
    this.ivaRate = props.ivaRate;
    this.iepsRate = props.iepsRate;
    this.purchaseCost = props.purchaseCost;
    this.useStock = props.useStock;
    this.useLotsAndExpirations = props.useLotsAndExpirations;
    this.quantity = props.quantity;
    this.minQuantity = props.minQuantity;
    this.hasVariants = props.hasVariants;
    this.serviceDetail = props.serviceDetail;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
    this.normalizeStockConfiguration();
  }

  /** Factory: creates a NEW product with domain validation. */
  static create(params: {
    id: string;
    name: string;
    location?: string | null;
    description?: string | null;
    type?: ProductType;
    sku?: string | null;
    barcode?: string | null;
    unit?: UnitOfMeasure;
    satKey?: string | null;
    categoryId?: string | null;
    brandId?: string | null;
    sellInPos?: boolean;
    includeInOnlineCatalog?: boolean;
    requiresPrescription?: boolean;
    chargeProductTaxes?: boolean;
    ivaRate?: IvaRateValue;
    iepsRate?: IepsRateValue;
    purchaseCostMode?: PurchaseCostModeValue;
    purchaseCostValue?: number; // in cents
    useStock?: boolean;
    useLotsAndExpirations?: boolean;
    quantity?: number;
    minQuantity?: number;
    hasVariants?: boolean;
  }): Product {
    const productName = ProductName.create(params.name);
    const type = params.type ?? 'PRODUCT';
    const unit = params.unit ?? 'UNIDAD';

    if (!VALID_UNITS.includes(unit)) {
      throw new InvalidArgumentError(
        `Invalid unit: ${unit}. Allowed: ${VALID_UNITS.join(', ')}`,
      );
    }

    const isService = type === SERVICE_FORCED_DEFAULTS.type;
    const sku = isService
      ? SERVICE_FORCED_DEFAULTS.sku
      : params.sku?.trim().toUpperCase() || null;
    const barcode = isService
      ? SERVICE_FORCED_DEFAULTS.barcode
      : params.barcode?.trim() || null;

    const ivaRate = IvaRate.create(params.ivaRate ?? 'IVA_16');
    const iepsRate = IepsRate.create(params.iepsRate ?? 'NO_APLICA');

    const costMode = isService
      ? SERVICE_FORCED_DEFAULTS.purchaseCostMode
      : (params.purchaseCostMode ?? 'NET');
    const costValue = isService
      ? SERVICE_FORCED_DEFAULTS.purchaseNetCostCents
      : (params.purchaseCostValue ?? 0);
    const purchaseCost = PurchaseCost.create(
      costMode,
      costValue,
      ivaRate.multiplier,
      iepsRate.multiplier,
    );

    const quantity = isService
      ? SERVICE_FORCED_DEFAULTS.quantity
      : (params.quantity ?? 0);
    const minQuantity = isService
      ? SERVICE_FORCED_DEFAULTS.minQuantity
      : (params.minQuantity ?? 0);

    if (quantity < 0) {
      throw new InvalidArgumentError('Quantity cannot be negative');
    }
    if (minQuantity < 0) {
      throw new InvalidArgumentError('Min quantity cannot be negative');
    }

    const now = new Date();
    return new Product({
      id: params.id,
      name: productName,
      location: params.location?.trim() || null,
      description: params.description?.trim() || null,
      type,
      sku,
      barcode,
      unit,
      satKey: params.satKey ?? null,
      categoryId: params.categoryId ?? null,
      brandId: isService ? SERVICE_FORCED_DEFAULTS.brandId : (params.brandId ?? null),
      sellInPos: params.sellInPos ?? true,
      includeInOnlineCatalog: params.includeInOnlineCatalog ?? true,
      requiresPrescription: params.requiresPrescription ?? false,
      chargeProductTaxes: params.chargeProductTaxes ?? true,
      ivaRate,
      iepsRate,
      purchaseCost,
      useStock: isService
        ? SERVICE_FORCED_DEFAULTS.useStock
        : (params.useStock ?? true),
      useLotsAndExpirations: isService
        ? SERVICE_FORCED_DEFAULTS.useLotsAndExpirations
        : (params.useLotsAndExpirations ?? false),
      quantity,
      minQuantity,
      hasVariants: params.hasVariants ?? false,
      serviceDetail: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Factory: reconstructs from DB (skips validation — data is already valid). */
  static fromPersistence(data: {
    id: string;
    name: string;
    location: string | null;
    description: string | null;
    type: string;
    sku: string | null;
    barcode: string | null;
    unit: string;
    satKey: string | null;
    categoryId: string | null;
    brandId: string | null;
    sellInPos: boolean;
    includeInOnlineCatalog: boolean;
    requiresPrescription: boolean;
    chargeProductTaxes: boolean;
    ivaRate: string;
    iepsRate: string;
    purchaseCostMode: string;
    purchaseNetCostCents: number;
    purchaseGrossCostCents: number;
    useStock: boolean;
    useLotsAndExpirations: boolean;
    quantity: number;
     minQuantity: number;
     hasVariants: boolean;
     serviceDetail?: ProductServiceDetail | null;
     createdAt: Date;
    updatedAt: Date;
  }): Product {
    return new Product({
      id: data.id,
      name: ProductName.fromPersistence({ name: data.name }),
      location: data.location,
      description: data.description,
      type: data.type as ProductType,
      sku: data.sku,
      barcode: data.barcode,
      unit: data.unit as UnitOfMeasure,
      satKey: data.satKey,
      categoryId: data.categoryId,
      brandId: data.brandId,
      sellInPos: data.sellInPos,
      includeInOnlineCatalog: data.includeInOnlineCatalog,
      requiresPrescription: data.requiresPrescription,
      chargeProductTaxes: data.chargeProductTaxes,
      ivaRate: IvaRate.fromPersistence(data.ivaRate),
      iepsRate: IepsRate.fromPersistence(data.iepsRate),
      purchaseCost: PurchaseCost.fromPersistence(
        data.purchaseCostMode as PurchaseCostModeValue,
        data.purchaseNetCostCents,
        data.purchaseGrossCostCents,
      ),
      useStock: data.useStock,
      useLotsAndExpirations: data.useLotsAndExpirations,
      quantity: data.quantity,
       minQuantity: data.minQuantity,
       hasVariants: data.hasVariants,
       serviceDetail: data.serviceDetail ?? null,
       createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    });
  }

  normalizeStockConfiguration(): void {
    if (!this.useStock) {
      this.useLotsAndExpirations = false;
      this.quantity = 0;
      this.minQuantity = 0;
      return;
    }

    if (this.hasVariants) {
      this.useLotsAndExpirations = false;
      this.quantity = 0;
      this.minQuantity = 0;
      return;
    }

    if (this.useLotsAndExpirations) {
      this.quantity = 0;
    }
  }

  static assertTypeChangeAllowed(
    current: Product,
    nextType: ProductType,
    activeLots: boolean | number = false,
  ): void {
    if (current.type !== 'PRODUCT' || nextType !== 'SERVICE') return;

    const hasActiveLots =
      typeof activeLots === 'number' ? activeLots > 0 : activeLots;
    if (current.quantity > 0 || hasActiveLots) {
      throw new BusinessRuleViolationError(
        'Cannot convert a PRODUCT to SERVICE while stock or active lots remain',
        'PRODUCT_TYPE_CHANGE_BLOCKED',
      );
    }
  }

  // ==================== Behavior ====================

  decreaseStock(qty: number): void {
    if (this.hasVariants) {
      throw new BusinessRuleViolationError(
        'Cannot modify stock directly on product with variants',
        'PRODUCT_HAS_VARIANTS',
      );
    }
    if (qty <= 0) throw new InvalidArgumentError('Quantity must be positive');
    if (this.quantity < qty) {
      throw new BusinessRuleViolationError(
        `Insufficient stock for "${this.name.productName}". Available: ${this.quantity}, requested: ${qty}`,
        'INSUFFICIENT_STOCK',
      );
    }
    this.quantity -= qty;
    this.updatedAt = new Date();
  }

  increaseStock(qty: number): void {
    if (this.hasVariants) {
      throw new BusinessRuleViolationError(
        'Cannot modify stock directly on product with variants',
        'PRODUCT_HAS_VARIANTS',
      );
    }
    if (qty <= 0) throw new InvalidArgumentError('Quantity must be positive');
    this.quantity += qty;
    this.updatedAt = new Date();
  }

  updateName(newName: string): void {
    this.name = ProductName.create(newName);
    this.updatedAt = new Date();
  }

  canSell(qty: number): boolean {
    if (!this.useStock) return true;
    return this.quantity >= qty && qty > 0;
  }

  isOutOfStock(): boolean {
    if (!this.useStock) return false;
    return this.quantity === 0;
  }

  // ==================== Serialization ====================

  toPersistence() {
    return {
      id: this.id,
      name: this.name.productName,
      location: this.location,
      description: this.description,
      type: this.type,
      sku: this.sku,
      barcode: this.barcode,
      unit: this.unit,
      satKey: this.satKey,
      categoryId: this.categoryId,
      brandId: this.brandId,
      sellInPos: this.sellInPos,
      includeInOnlineCatalog: this.includeInOnlineCatalog,
      requiresPrescription: this.requiresPrescription,
      chargeProductTaxes: this.chargeProductTaxes,
      ivaRate: this.ivaRate.value,
      iepsRate: this.iepsRate.value,
      purchaseCostMode: this.purchaseCost.mode,
      purchaseNetCostCents: this.purchaseCost.netCents,
      purchaseGrossCostCents: this.purchaseCost.grossCents,
      useStock: this.useStock,
      useLotsAndExpirations: this.useLotsAndExpirations,
      quantity: this.quantity,
      minQuantity: this.minQuantity,
      hasVariants: this.hasVariants,
    };
  }

  toResponse() {
    return {
      id: this.id,
      name: this.name.productName,
      location: this.location,
      description: this.description,
      type: this.type,
      sku: this.sku,
      barcode: this.barcode,
      unit: this.unit,
      satKey: this.satKey,
      categoryId: this.categoryId,
      brandId: this.brandId,
      sellInPos: this.sellInPos,
      includeInOnlineCatalog: this.includeInOnlineCatalog,
      requiresPrescription: this.requiresPrescription,
      chargeProductTaxes: this.chargeProductTaxes,
      ivaRate: this.ivaRate.value,
      iepsRate: this.iepsRate.value,
      purchaseCost: {
        mode: this.purchaseCost.mode,
        netCents: this.purchaseCost.netCents,
        grossCents: this.purchaseCost.grossCents,
        netDecimal: this.purchaseCost.netDecimal,
        grossDecimal: this.purchaseCost.grossDecimal,
      },
      useStock: this.useStock,
      useLotsAndExpirations: this.useLotsAndExpirations,
      quantity: this.quantity,
       minQuantity: this.minQuantity,
       hasVariants: this.hasVariants,
       serviceDetail: this.serviceDetail
         ? {
             capacity: this.serviceDetail.capacity,
             notes: this.serviceDetail.notes,
           }
         : null,
       createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
