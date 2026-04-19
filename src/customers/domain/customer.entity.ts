import { InvalidArgumentError } from '../../shared/domain/domain-error';

export interface CustomerAddressProps {
  id: string;
  street: string;
  exteriorNumber: string | null;
  interiorNumber: string | null;
  zipCode: string | null;
  neighborhood: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerProps {
  id: string;
  firstName: string;
  lastName: string | null;
  phoneCountryCode: string | null;
  phone: string | null;
  email: string | null;
  globalPriceListId: string | null;
  comments: string | null;

  // Billing
  businessName: string | null;
  fiscalZipCode: string | null;
  rfc: string | null;
  fiscalRegime: string | null;
  billingStreet: string | null;
  billingExteriorNumber: string | null;
  billingInteriorNumber: string | null;
  billingZipCode: string | null;
  billingNeighborhood: string | null;
  billingMunicipality: string | null;
  billingCity: string | null;
  billingState: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export class Customer {
  public readonly id: string;
  public firstName: string;
  public lastName: string | null;
  public phoneCountryCode: string | null;
  public phone: string | null;
  public email: string | null;
  public globalPriceListId: string | null;
  public comments: string | null;

  public businessName: string | null;
  public fiscalZipCode: string | null;
  public rfc: string | null;
  public fiscalRegime: string | null;
  public billingStreet: string | null;
  public billingExteriorNumber: string | null;
  public billingInteriorNumber: string | null;
  public billingZipCode: string | null;
  public billingNeighborhood: string | null;
  public billingMunicipality: string | null;
  public billingCity: string | null;
  public billingState: string | null;

  public readonly createdAt: Date;
  public updatedAt: Date;

  private constructor(props: CustomerProps) {
    this.id = props.id;
    this.firstName = props.firstName;
    this.lastName = props.lastName;
    this.phoneCountryCode = props.phoneCountryCode;
    this.phone = props.phone;
    this.email = props.email;
    this.globalPriceListId = props.globalPriceListId;
    this.comments = props.comments;
    this.businessName = props.businessName;
    this.fiscalZipCode = props.fiscalZipCode;
    this.rfc = props.rfc;
    this.fiscalRegime = props.fiscalRegime;
    this.billingStreet = props.billingStreet;
    this.billingExteriorNumber = props.billingExteriorNumber;
    this.billingInteriorNumber = props.billingInteriorNumber;
    this.billingZipCode = props.billingZipCode;
    this.billingNeighborhood = props.billingNeighborhood;
    this.billingMunicipality = props.billingMunicipality;
    this.billingCity = props.billingCity;
    this.billingState = props.billingState;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(params: {
    id: string;
    firstName: string;
    lastName?: string | null;
    phoneCountryCode?: string | null;
    phone?: string | null;
    email?: string | null;
    globalPriceListId?: string | null;
    comments?: string | null;
    businessName?: string | null;
    fiscalZipCode?: string | null;
    rfc?: string | null;
    fiscalRegime?: string | null;
    billingStreet?: string | null;
    billingExteriorNumber?: string | null;
    billingInteriorNumber?: string | null;
    billingZipCode?: string | null;
    billingNeighborhood?: string | null;
    billingMunicipality?: string | null;
    billingCity?: string | null;
    billingState?: string | null;
  }): Customer {
    const firstName = params.firstName?.trim();
    if (!firstName) {
      throw new InvalidArgumentError('Customer first name is required');
    }

    const now = new Date();
    return new Customer({
      id: params.id,
      firstName,
      lastName: params.lastName?.trim() || null,
      phoneCountryCode: params.phoneCountryCode?.trim() || null,
      phone: params.phone?.trim() || null,
      email: params.email?.trim().toLowerCase() || null,
      globalPriceListId: params.globalPriceListId ?? null,
      comments: params.comments?.trim() || null,
      businessName: params.businessName?.trim() || null,
      fiscalZipCode: params.fiscalZipCode?.trim() || null,
      rfc: params.rfc?.trim().toUpperCase() || null,
      fiscalRegime: params.fiscalRegime ?? null,
      billingStreet: params.billingStreet?.trim() || null,
      billingExteriorNumber: params.billingExteriorNumber?.trim() || null,
      billingInteriorNumber: params.billingInteriorNumber?.trim() || null,
      billingZipCode: params.billingZipCode?.trim() || null,
      billingNeighborhood: params.billingNeighborhood?.trim() || null,
      billingMunicipality: params.billingMunicipality?.trim() || null,
      billingCity: params.billingCity?.trim() || null,
      billingState: params.billingState ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static fromPersistence(data: CustomerProps): Customer {
    return new Customer({
      ...data,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
    });
  }

  toPersistence() {
    return {
      id: this.id,
      firstName: this.firstName,
      lastName: this.lastName,
      phoneCountryCode: this.phoneCountryCode,
      phone: this.phone,
      email: this.email,
      globalPriceListId: this.globalPriceListId,
      comments: this.comments,
      businessName: this.businessName,
      fiscalZipCode: this.fiscalZipCode,
      rfc: this.rfc,
      fiscalRegime: this.fiscalRegime,
      billingStreet: this.billingStreet,
      billingExteriorNumber: this.billingExteriorNumber,
      billingInteriorNumber: this.billingInteriorNumber,
      billingZipCode: this.billingZipCode,
      billingNeighborhood: this.billingNeighborhood,
      billingMunicipality: this.billingMunicipality,
      billingCity: this.billingCity,
      billingState: this.billingState,
    };
  }

  toResponse() {
    return {
      id: this.id,
      firstName: this.firstName,
      lastName: this.lastName,
      phoneCountryCode: this.phoneCountryCode,
      phone: this.phone,
      email: this.email,
      globalPriceListId: this.globalPriceListId,
      comments: this.comments,
      businessName: this.businessName,
      fiscalZipCode: this.fiscalZipCode,
      rfc: this.rfc,
      fiscalRegime: this.fiscalRegime,
      billingStreet: this.billingStreet,
      billingExteriorNumber: this.billingExteriorNumber,
      billingInteriorNumber: this.billingInteriorNumber,
      billingZipCode: this.billingZipCode,
      billingNeighborhood: this.billingNeighborhood,
      billingMunicipality: this.billingMunicipality,
      billingCity: this.billingCity,
      billingState: this.billingState,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
