import { Module } from '@nestjs/common';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { PdfParserService } from './pdf-parser.service';
import { PdfImportService } from './pdf-import.service';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [UploadModule],
  controllers: [ImportController],
  providers: [ImportService, PdfParserService, PdfImportService],
  exports: [PdfParserService, PdfImportService],
})
export class ImportModule {}
