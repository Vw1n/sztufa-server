import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateNewsDto } from './dto/create-news.dto';
import { UpdateNewsDto } from './dto/update-news.dto';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class NewsService {
  constructor(
    private prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(createNewsDto: CreateNewsDto, username: string = 'admin') {
    const news = await this.prisma.news.create({
      data: {
        title: createNewsDto.title,
        description: createNewsDto.description,
        category: createNewsDto.category,
        coverImage: createNewsDto.coverImage || null,
        wechatUrl: createNewsDto.wechatUrl,
        date: createNewsDto.date,
      },
    });

    await this.auditLogService.log(username, 'CREATE_NEWS', `创建活动资讯: "${news.title}"`);

    return news;
  }

  async findAll(page: number = 1, limit: number = 10, category?: string) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 10));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { deletedAt: null };
    if (category && category !== 'all' && category.trim() !== '') {
      where.category = category;
    }

    const [data, total] = await Promise.all([
      this.prisma.news.findMany({
        skip,
        take: limitNum,
        where,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.news.count({ where }),
    ]);

    return { data, total, page: pageNum, limit: limitNum };
  }

  async findOne(id: string) {
    const news = await this.prisma.news.findUnique({
      where: { id },
    });
    if (!news || news.deletedAt !== null) {
      throw new NotFoundException('该资讯不存在');
    }
    return news;
  }

  async update(id: string, updateNewsDto: UpdateNewsDto, username: string = 'admin') {
    const news = await this.prisma.news.findUnique({ where: { id } });
    if (!news || news.deletedAt !== null) {
      throw new NotFoundException('该资讯不存在');
    }

    const updatedNews = await this.prisma.news.update({
      where: { id },
      data: updateNewsDto,
    });

    await this.auditLogService.log(username, 'UPDATE_NEWS', `修改活动资讯 "${news.title}" 详情`);

    return updatedNews;
  }

  async remove(id: string, username: string = 'admin') {
    const news = await this.prisma.news.findUnique({ where: { id } });
    if (!news || news.deletedAt !== null) {
      throw new NotFoundException('该资讯不存在');
    }

    const deletedNews = await this.prisma.news.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.auditLogService.log(username, 'DELETE_NEWS', `删除活动资讯: "${news.title}"`);

    return deletedNews;
  }
}
