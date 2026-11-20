import { Injectable } from '@nestjs/common';
import type {
  BackorderReservationRef,
  BackorderReservationReleaser,
} from '../application/ports/backorder-reservation-releaser.port';

/**
 * Binding of `BACKORDER_RESERVATION_RELEASER` while no reservation can exist:
 * a `RESERVED` backorder needs the `BACKORDER_RESERVE` journal movement, which
 * the reserve/allocate task introduces together with the real releaser. Returns
 * without any stock effect.
 */
@Injectable()
export class NoOpBackorderReservationReleaser implements BackorderReservationReleaser {
  releaseReservation(reservation: BackorderReservationRef): Promise<void> {
    void reservation;
    return Promise.resolve();
  }
}
