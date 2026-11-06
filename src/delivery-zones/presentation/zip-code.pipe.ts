import { BadRequestException, PipeTransform } from '@nestjs/common';
import { isValidZipCode } from '../domain/delivery-zone.policy';

/** `:zipCode` route param: exactly five digits, else a value-free 400. */
export class ParseZipCodePipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (!isValidZipCode(value)) {
      throw new BadRequestException('zipCode must be exactly five digits');
    }
    return value;
  }
}
