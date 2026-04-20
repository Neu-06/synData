import { Module } from '@nestjs/common';
import { SyntheticDataModule } from './modules/synthetic-data/synthetic-data.module';

@Module({
  imports: [SyntheticDataModule],
})
export class AppModule {}
