import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Public } from '../auth/access';
import { ShoppingService } from './shopping.service';
import { SearchAvailabilityDto } from './dto/search-availability.dto';
import { CheckCartDto } from './dto/check-cart.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';

@Controller('shopping')
export class ShoppingController {
  constructor(private readonly shoppingService: ShoppingService) {}

  @Public()
  @Get('service-areas')
  getServiceAreas() {
    return this.shoppingService.getServiceAreas();
  }

  @Public()
  @Post('availability/search')
  searchAvailability(@Body() dto: SearchAvailabilityDto) {
    return this.shoppingService.searchAvailability(dto);
  }

  @Public()
  @Post('cart/check')
  checkCart(@Body() dto: CheckCartDto) {
    return this.shoppingService.checkCart(dto);
  }

  @Public()
  @Post('quotes')
  createQuote(@Body() dto: CreateQuoteDto) {
    return this.shoppingService.createQuote(dto);
  }

  @Public()
  @Get('quotes/:id')
  getQuoteById(@Param('id') id: string) {
    return this.shoppingService.getQuoteById(id);
  }
}

