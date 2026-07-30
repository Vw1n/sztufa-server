import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import sharp from 'sharp';
import { ParsedFieldDto, ParsedPlayerDto, ParsedTeamDto } from './dto/pdf-import.dto';

export interface ExtractedImageItem {
  id: string;
  buffer: Buffer;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

export interface ExtractedTextItem {
  text: string;
  x: number;
  y: number;
  page: number;
}

export const MAX_PDF_SIZE = 20 * 1024 * 1024; // 20MB
export const MAX_PDF_PAGES = 50;
export const PARSE_TIMEOUT_MS = 15000; // 15s 超时

// 保留原生 import()，避免 CommonJS 编译把 .mjs 加载改写成 require()。
// Node 20 不允许 require() 加载 pdfjs-dist 的 ESM 入口。
const importEsmModule = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<any>;

@Injectable()
export class PdfParserService {
  private readonly logger = new Logger(PdfParserService.name);

  async parseRegistrationPdf(
    file: Express.Multer.File,
  ): Promise<{ teams: ParsedTeamDto[]; extractedImages: ExtractedImageItem[] }> {
    const abortSignal = { aborted: false };
    let timeoutTimer: NodeJS.Timeout;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        abortSignal.aborted = true;
        reject(new BadRequestException('PDF 解析超时 (超过 15 秒限制)，文件可能过于复杂'));
      }, PARSE_TIMEOUT_MS);
    });

    try {
      const parsePromise = this.doParseRegistrationPdf(file, abortSignal);
      return await Promise.race([parsePromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutTimer!);
    }
  }

  private async doParseRegistrationPdf(
    file: Express.Multer.File,
    abortSignal: { aborted: boolean },
  ): Promise<{ teams: ParsedTeamDto[]; extractedImages: ExtractedImageItem[] }> {
    if (!file || !file.buffer) {
      throw new BadRequestException('请提供有效的 PDF 文件');
    }

    if (file.size > MAX_PDF_SIZE) {
      throw new BadRequestException('PDF 文件大小超过限制 (最大允许 20MB)');
    }

    const magic = file.buffer.subarray(0, 5).toString('ascii');
    if (!magic.startsWith('%PDF-')) {
      throw new BadRequestException('无效的 PDF 文件类型，文件头魔数校验失败');
    }

    let doc: any;
    let pdfjs: any;
    try {
      pdfjs = await this.loadPdfJs();
      const data = new Uint8Array(file.buffer);
      doc = await pdfjs.getDocument({ data }).promise;
    } catch (err: any) {
      this.logger.error('PDF 解析失败或文件已损坏', err);
      const errorMessage = String(err?.message || err);
      if (this.isPdfRuntimeConfigurationError(errorMessage)) {
        throw new ServiceUnavailableException('PDF 解析服务部署配置异常，请稍后重试或联系管理员');
      }
      throw new UnprocessableEntityException('PDF 文件损坏或被加密，无法解密解析');
    }

    if (!doc || doc.numPages === 0) {
      throw new BadRequestException('PDF 文件不包含有效页面');
    }

    if (doc.numPages > MAX_PDF_PAGES) {
      throw new BadRequestException(
        `PDF 页数过多 (当前 ${doc.numPages} 页，最多允许 ${MAX_PDF_PAGES} 页)`,
      );
    }

    let totalTextCount = 0;
    const pageTexts: { page: number; items: ExtractedTextItem[] }[] = [];
    const pageImages: ExtractedImageItem[] = [];

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      if (abortSignal.aborted) {
        throw new BadRequestException('PDF 解析因超时被中途终止');
      }

      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();

      const textItems: ExtractedTextItem[] = textContent.items
        .map((item: any) => ({
          text: String(item.str || '').trim(),
          x: Math.round(item.transform[4]),
          y: Math.round(item.transform[5]),
          page: pageNum,
        }))
        .filter((item: ExtractedTextItem) => item.text.length > 0);

      totalTextCount += textItems.length;
      pageTexts.push({ page: pageNum, items: textItems });

      const opList = await page.getOperatorList();
      const transformStack: number[][] = [];
      let currentTransform = [1, 0, 0, 1, 0, 0];

      for (let i = 0; i < opList.fnArray.length; i++) {
        if (abortSignal.aborted) {
          throw new BadRequestException('PDF 解析因超时被中途终止');
        }

        const fn = opList.fnArray[i];
        const args = opList.argsArray[i];

        if (fn === pdfjs.OPS.save) {
          transformStack.push([...currentTransform]);
        } else if (fn === pdfjs.OPS.restore) {
          if (transformStack.length > 0) {
            currentTransform = transformStack.pop()!;
          }
        } else if (fn === pdfjs.OPS.transform) {
          currentTransform = this.multiplyMatrix(currentTransform, args);
        } else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) {
          const imgName = args[0];
          const imgObj = page.objs.get(imgName);

          const x = Math.round(currentTransform[4]);
          const y = Math.round(currentTransform[5]);
          const w = Math.round(Math.abs(currentTransform[0]));
          const h = Math.round(Math.abs(currentTransform[3]));

          if (imgObj && imgObj.data) {
            try {
              const imageBuffer = await this.convertRawImageToWebp(imgObj);
              if (imageBuffer) {
                pageImages.push({
                  id: `p${pageNum}_${imgName}_${pageImages.length + 1}`,
                  buffer: imageBuffer,
                  x,
                  y,
                  width: w,
                  height: h,
                  page: pageNum,
                });
              }
            } catch (imgErr) {
              this.logger.warn(`提取 PDF 页面 ${pageNum} 图像 ${imgName} 失败`, imgErr);
            }
          }
        }
      }
    }

    if (totalTextCount < 10) {
      throw new BadRequestException('第一期暂不支持扫描图片件，请上传原生文本 PDF 报名表');
    }

    const teams = this.extractTeamsFromPageData(pageTexts, pageImages);

    if (teams.length === 0) {
      throw new BadRequestException(
        '未能在 PDF 中识别出有效格式的球队报名表，请核对是否符合官方模板',
      );
    }

    return { teams, extractedImages: pageImages };
  }

  private loadPdfJs(): Promise<any> {
    return importEsmModule('pdfjs-dist/legacy/build/pdf.mjs');
  }

  private isPdfRuntimeConfigurationError(message: string): boolean {
    const normalized = message.toLowerCase();
    return [
      'setting up fake worker failed',
      'pdf.worker.js',
      'pdf.worker.mjs',
      'cannot find module',
      'cannot find package',
      'module not found',
      'failed to import',
      'failed to fetch dynamically imported module',
      'dommatrix is not defined',
      'imagedata is not defined',
      'path2d is not defined',
    ].some((fragment) => normalized.includes(fragment));
  }

  private multiplyMatrix(m1: number[], m2: number[]): number[] {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
  }

  private async convertRawImageToWebp(imgObj: any): Promise<Buffer | null> {
    try {
      const width = imgObj.width;
      const height = imgObj.height;
      if (!width || !height || !imgObj.data) return null;

      let channels = 4;
      if (imgObj.kind === 1) channels = 1;
      else if (imgObj.kind === 2) channels = 3;
      else if (imgObj.kind === 3) channels = 4;

      const sharpInput = {
        raw: {
          width,
          height,
          channels: channels as 1 | 2 | 3 | 4,
        },
      };

      let quality = 80;
      let targetWidth = 400;
      let targetHeight = 533;

      let buf = await sharp(Buffer.from(imgObj.data), sharpInput)
        .rotate()
        .resize({
          width: targetWidth,
          height: targetHeight,
          fit: 'cover',
          withoutEnlargement: true,
        })
        .webp({ quality })
        .toBuffer();

      // 强保证 WebP 输出体积绝对 ≤ 200KB：如超限，循环降低质量与分辨率直至绝对达标
      while (buf.length > 200 * 1024 && quality >= 20) {
        quality -= 15;
        targetWidth = Math.round(targetWidth * 0.85);
        targetHeight = Math.round(targetHeight * 0.85);
        buf = await sharp(Buffer.from(imgObj.data), sharpInput)
          .rotate()
          .resize({ width: targetWidth, height: targetHeight, fit: 'cover' })
          .webp({ quality })
          .toBuffer();
      }

      if (buf.length > 200 * 1024) return null;
      return buf;
    } catch {
      try {
        let quality = 80;
        let targetWidth = 400;
        let targetHeight = 533;

        let buf = await sharp(Buffer.from(imgObj.data))
          .resize({
            width: targetWidth,
            height: targetHeight,
            fit: 'cover',
            withoutEnlargement: true,
          })
          .webp({ quality })
          .toBuffer();

        while (buf.length > 200 * 1024 && quality >= 20) {
          quality -= 15;
          targetWidth = Math.round(targetWidth * 0.85);
          targetHeight = Math.round(targetHeight * 0.85);
          buf = await sharp(Buffer.from(imgObj.data))
            .resize({ width: targetWidth, height: targetHeight, fit: 'cover' })
            .webp({ quality })
            .toBuffer();
        }

        if (buf.length > 200 * 1024) return null;
        return buf;
      } catch {
        return null;
      }
    }
  }

  private extractTeamsFromPageData(
    pageTexts: { page: number; items: ExtractedTextItem[] }[],
    images: ExtractedImageItem[],
  ): ParsedTeamDto[] {
    const teams: ParsedTeamDto[] = [];
    let currentTeam: Partial<ParsedTeamDto> | null = null;

    for (const pageData of pageTexts) {
      const pageNum = pageData.page;
      const items = pageData.items;

      const hasTeamHeader = items.some(
        (i) =>
          i.text.includes('报名表') ||
          i.text.includes('参赛球队信息') ||
          i.text.includes('队伍名称'),
      );

      if (hasTeamHeader || !currentTeam) {
        if (currentTeam && currentTeam.teamName?.value) {
          teams.push(currentTeam as ParsedTeamDto);
        }
        currentTeam = this.createNewTeamDto(pageNum);
        this.parseTeamHeaderFields(currentTeam, items, pageNum);
        this.assignTeamImages(currentTeam, items, images, pageNum);
      }

      const pagePlayers = this.extractPlayersFromPage(items, images, pageNum);
      if (currentTeam && currentTeam.players) {
        currentTeam.players.push(...pagePlayers);
      }
    }

    if (currentTeam && currentTeam.teamName?.value) {
      teams.push(currentTeam as ParsedTeamDto);
    }

    return teams;
  }

  private createNewTeamDto(page: number): ParsedTeamDto {
    const defaultField = (val: string | null = null, conf = 1.0): ParsedFieldDto<string> => ({
      value: val,
      confidence: conf,
      page,
      manuallyConfirmed: false,
    });

    return {
      teamName: defaultField(),
      headCoach: defaultField(),
      coachPhone: defaultField(),
      teamLeader: defaultField(),
      leaderPhone: defaultField(),
      teamDoctor: defaultField(),
      homeJerseyColor: defaultField(),
      awayJerseyColor: defaultField(),
      logo: defaultField(),
      homeJerseyPhoto: defaultField(),
      awayJerseyPhoto: defaultField(),
      players: [],
    };
  }

  private assignTeamImages(
    team: Partial<ParsedTeamDto>,
    items: ExtractedTextItem[],
    images: ExtractedImageItem[],
    page: number,
  ) {
    const pageImages = images.filter((image) => image.page === page);
    const findImageBelowLabel = (labels: string[]): ExtractedImageItem | null => {
      const label = items.find((item) => labels.some((text) => item.text.includes(text)));
      if (!label) return null;

      const candidates = pageImages
        .map((image) => {
          const centerX = image.x + image.width / 2;
          const centerY = image.y + image.height / 2;
          return {
            image,
            horizontalDistance: Math.abs(centerX - label.x),
            verticalDistance: label.y - centerY,
          };
        })
        .filter(
          ({ horizontalDistance, verticalDistance }) =>
            horizontalDistance <= 70 && verticalDistance >= 0 && verticalDistance <= 140,
        )
        .sort(
          (a, b) =>
            a.horizontalDistance +
            a.verticalDistance * 0.2 -
            (b.horizontalDistance + b.verticalDistance * 0.2),
        );

      return candidates[0]?.image || null;
    };

    const logo = findImageBelowLabel(['队徽']);
    const homeJersey = findImageBelowLabel(['队服（主）', '队服(主)']);
    const awayJersey = findImageBelowLabel(['队服（客）', '队服(客)']);
    const field = (image: ExtractedImageItem | null): ParsedFieldDto<string> => ({
      value: image?.id || null,
      confidence: image ? 1 : 0,
      page,
      manuallyConfirmed: false,
    });

    team.logo = field(logo);
    team.homeJerseyPhoto = field(homeJersey);
    team.awayJerseyPhoto = field(awayJersey);
  }

  private parseTeamHeaderFields(
    team: Partial<ParsedTeamDto>,
    items: ExtractedTextItem[],
    page: number,
  ) {
    for (let i = 0; i < items.length; i++) {
      const text = items[i].text;

      if (text.includes('队伍名称')) {
        const nextHeaderIndex = items.findIndex(
          (item, itemIndex) => itemIndex > i && item.text.includes('队医姓名'),
        );
        const candidates = items
          .slice(i + 1, nextHeaderIndex > i ? nextHeaderIndex : undefined)
          .filter(
            (item) =>
              item.x > items[i].x + 40 &&
              item.x < items[i].x + 200 &&
              Math.abs(item.y - items[i].y) <= 12,
          );
        const val =
          candidates.map((item) => item.text).join('') || this.extractFieldValue(items, i);
        if (val) {
          team.teamName = {
            value: val,
            confidence: 1.0,
            page,
            manuallyConfirmed: false,
          };
        }
      } else if (text.includes('主教练姓名')) {
        const val = this.extractFieldValue(items, i);
        if (val) team.headCoach = { value: val, confidence: 1.0, page, manuallyConfirmed: false };
      } else if (text.includes('主教练联系方式') || text.includes('教练电话')) {
        const val = this.extractFieldValue(items, i);
        if (val) team.coachPhone = { value: val, confidence: 1.0, page, manuallyConfirmed: false };
      } else if (text.includes('领队姓名')) {
        const val = this.extractFieldValue(items, i);
        if (val) team.teamLeader = { value: val, confidence: 1.0, page, manuallyConfirmed: false };
      } else if (text.includes('领队联系方式') || text.includes('领队电话')) {
        const val = this.extractFieldValue(items, i);
        if (val) team.leaderPhone = { value: val, confidence: 1.0, page, manuallyConfirmed: false };
      } else if (text.includes('队医姓名')) {
        const val = this.extractFieldValue(items, i);
        if (val) team.teamDoctor = { value: val, confidence: 1.0, page, manuallyConfirmed: false };
      } else if (text.includes('主队球衣颜色')) {
        const val = this.extractFieldValue(items, i);
        if (val)
          team.homeJerseyColor = { value: val, confidence: 1.0, page, manuallyConfirmed: false };
      } else if (text.includes('客队球衣颜色')) {
        const val = this.extractFieldValue(items, i);
        if (val)
          team.awayJerseyColor = { value: val, confidence: 1.0, page, manuallyConfirmed: false };
      }
    }
  }

  private extractFieldValue(items: ExtractedTextItem[], index: number): string {
    const labelItem = items[index];
    const candidate = items.find(
      (item, idx) =>
        idx > index && Math.abs(item.y - labelItem.y) < 10 && item.x > labelItem.x + 40,
    );
    return candidate ? candidate.text : '';
  }

  private extractPlayersFromPage(
    items: ExtractedTextItem[],
    images: ExtractedImageItem[],
    page: number,
  ): ParsedPlayerDto[] {
    const players: ParsedPlayerDto[] = [];
    const studentIdLabels = items.filter((item) => item.text.includes('学号'));
    const studentIdItems = items.filter(
      (item) =>
        /^\d{10,12}$/.test(item.text) &&
        studentIdLabels.some((label) => Math.abs(label.y - item.y) < 15 && label.x < item.x),
    );

    if (studentIdItems.length === 0) return players;

    const yGroups: { y: number; items: ExtractedTextItem[] }[] = [];
    studentIdItems.forEach((stItem) => {
      let group = yGroups.find((g) => Math.abs(g.y - stItem.y) < 15);
      if (!group) {
        group = { y: stItem.y, items: [] };
        yGroups.push(group);
      }
      group.items.push(stItem);
    });

    const pageImages = images.filter((img) => img.page === page);
    const assignedImageIds = new Set<string>();

    for (const group of yGroups) {
      group.items.sort((a, b) => a.x - b.x);

      for (const stItem of group.items) {
        const studentId = stItem.text;
        const playerX = stItem.x;
        const playerY = stItem.y;

        const nameItem = items.find(
          (i) =>
            Math.abs(i.x - playerX) < 50 &&
            i.y > playerY &&
            i.y <= playerY + 30 &&
            !/^\d+$/.test(i.text) &&
            !i.text.includes('学号') &&
            !i.text.includes('姓名'),
        );

        const jerseyItem = items.find(
          (i) =>
            Math.abs(i.x - playerX) < 50 &&
            i.y < playerY &&
            i.y >= playerY - 30 &&
            /^\d+$/.test(i.text),
        );

        const name = nameItem ? nameItem.text : '';
        const jerseyNumber = jerseyItem ? jerseyItem.text : '';

        const playerBox = {
          minX: playerX - 40,
          maxX: playerX + 40,
          minY: playerY + 10,
          maxY: playerY + 110,
        };

        let bestMatchedImage: ExtractedImageItem | null = null;
        let highestScore = 0;

        for (const img of pageImages) {
          if (assignedImageIds.has(img.id)) continue;

          const imgBox = {
            minX: img.x,
            maxX: img.x + img.width,
            minY: img.y,
            maxY: img.y + img.height,
          };

          const interMinX = Math.max(playerBox.minX, imgBox.minX);
          const interMaxX = Math.min(playerBox.maxX, imgBox.maxX);
          const interMinY = Math.max(playerBox.minY, imgBox.minY);
          const interMaxY = Math.min(playerBox.maxY, imgBox.maxY);

          const interWidth = Math.max(0, interMaxX - interMinX);
          const interHeight = Math.max(0, interMaxY - interMinY);
          const intersectionArea = interWidth * interHeight;

          const playerArea = (playerBox.maxX - playerBox.minX) * (playerBox.maxY - playerBox.minY);
          const imgArea = img.width * img.height;
          const unionArea = playerArea + imgArea - intersectionArea;

          const iouScore = unionArea > 0 ? intersectionArea / unionArea : 0;

          const imgCenterX = img.x + img.width / 2;
          const imgCenterY = img.y + img.height / 2;
          const deltaX = Math.abs(imgCenterX - playerX);
          const deltaY = imgCenterY - playerY;

          if (deltaX <= 65 && deltaY >= 20 && deltaY <= 190) {
            const columnScore = Math.max(0, 1 - deltaX / 65);
            const verticalScore = Math.max(0, 1 - Math.abs(deltaY - 90) / 120);
            const totalScore = iouScore * 0.25 + columnScore * 0.5 + verticalScore * 0.25;

            if (totalScore > highestScore) {
              highestScore = totalScore;
              bestMatchedImage = img;
            }
          }
        }

        let photoConfidence = 1.0;
        const warnings: string[] = [];
        let needsManualConfirm = false;

        if (bestMatchedImage && highestScore >= 0.3) {
          assignedImageIds.add(bestMatchedImage.id);
          if (highestScore < 0.6) {
            photoConfidence = 0.6;
            warnings.push('照片与球员位置交集置信度较低，请人工确认');
            needsManualConfirm = true;
          }
        } else {
          bestMatchedImage = null;
          photoConfidence = 0.0;
          warnings.push('未检测到匹配的免冠照');
          needsManualConfirm = true;
        }

        players.push({
          name: {
            value: name,
            confidence: name ? 1.0 : 0.0,
            page,
            manuallyConfirmed: false,
          },
          studentId: {
            value: studentId,
            confidence: 1.0,
            page,
            manuallyConfirmed: false,
          },
          jerseyNumber: {
            value: jerseyNumber,
            confidence: jerseyNumber ? 1.0 : 0.0,
            page,
            manuallyConfirmed: false,
          },
          photo: {
            value: bestMatchedImage ? bestMatchedImage.id : null,
            confidence: photoConfidence,
            page,
            warnings: warnings.length > 0 ? warnings : undefined,
            manuallyConfirmed: false,
          },
          needsManualConfirm: needsManualConfirm || !name || !jerseyNumber,
        });
      }
    }

    return players;
  }
}
