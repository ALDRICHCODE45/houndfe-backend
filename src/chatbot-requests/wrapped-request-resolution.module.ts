/**
 * Binds the common `resolve` command to the existing resolve use cases (unit
 * 3). It lives apart from `ChatbotRequestsModule` so the inbox module itself
 * stays light: this is the only place that imports the stock, zone and
 * receipt modules.
 */
import { Module } from '@nestjs/common';
import { DeliveryZonesModule } from '../delivery-zones/delivery-zones.module';
import { HumanDecisionsModule } from '../human-decisions/human-decisions.module';
import { SalesModule } from '../sales/sales.module';
import { CHATBOT_REQUEST_RESOLVER } from './application/chatbot-request-commands.service';
import { ChatbotRequestWrapperModule } from './chatbot-request-wrapper.module';
import { WrappedRequestResolver } from './infrastructure/wrapped-request-resolver';

@Module({
  imports: [
    HumanDecisionsModule,
    DeliveryZonesModule,
    SalesModule,
    ChatbotRequestWrapperModule,
  ],
  providers: [
    { provide: CHATBOT_REQUEST_RESOLVER, useClass: WrappedRequestResolver },
  ],
  exports: [CHATBOT_REQUEST_RESOLVER],
})
export class WrappedRequestResolutionModule {}
